import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  cancelTaskResponseSchema,
  deviceExecuteTaskBodySchema,
  deviceExecuteTaskResponseSchema,
  deviceInfoSchema,
  deviceListResponseSchema,
  devicePairingDecisionResponseSchema,
  devicePairingListResponseSchema,
  devicePairingQrResponseSchema,
  devicePushMediaBodySchema,
  devicePushMediaResponseSchema,
  deviceRenameBodySchema,
} from "@nexu/shared";
import { streamSSE } from "hono/streaming";
import type { ControllerContainer } from "../app/container.js";
import {
  DeviceControlRpcError,
  DeviceControlTimeoutError,
} from "../services/device-control-service.js";
import {
  type DeviceChangeEvent,
  deviceEventEmitter,
} from "../services/device-event-emitter.js";
import type { ControllerBindings } from "../types.js";

const deviceIdParamSchema = z.object({ deviceId: z.string() });
const taskIdParamSchema = z.object({
  deviceId: z.string(),
  taskId: z.string(),
});
const renameParamSchema = z.object({ deviceId: z.string() });
const errorSchema = z.object({ message: z.string() });
const pairingRequestParamSchema = z.object({ requestId: z.string().min(1) });

function mapRpcErrorToStatus(err: unknown): {
  status: 404 | 503 | 504 | 500;
  message: string;
} {
  if (err instanceof DeviceControlRpcError) {
    if (err.code === "DEVICE_NOT_FOUND") {
      return { status: 404, message: err.message };
    }
    if (err.code === "DEVICE_OFFLINE") {
      return { status: 503, message: err.message };
    }
    if (err.code === "TIMEOUT") {
      return { status: 504, message: err.message };
    }
    return { status: 500, message: err.message };
  }
  // A transport timeout is not a failed publish: the phone is very often still
  // working and goes on to finish. It has to reach the caller as 504 so the UI
  // can say "result unconfirmed" instead of "failed" — the old undici error was
  // a bare TypeError, fell through to 500, and that 504 path never once ran.
  if (err instanceof DeviceControlTimeoutError) {
    return { status: 504, message: err.message };
  }
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { status: 504, message: "Device control request timed out" };
  }
  return {
    status: 500,
    message: err instanceof Error ? err.message : "Unknown error",
  };
}

export function registerDeviceControlRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  // ── Non-OpenAPI endpoints (SSE + internal webhook) ──────────────────────────

  // GET /api/v1/devices/stream — SSE for real-time device list updates
  app.get("/api/v1/devices/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      await stream.writeSSE({ data: "connected", event: "connected" });

      // Send an initial device_list snapshot. This MUST go out in every case —
      // available, unavailable, or lookup failure — so the client can clear its
      // loading state. Otherwise an unavailable device-control plugin leaves the
      // SSE open but silent (no device_list event, and no error to trigger the
      // client's polling fallback), and the devices page spins forever.
      try {
        const list = (await container.deviceControlService.isAvailable())
          ? await container.deviceControlService.listDevices()
          : { devices: [] };
        await stream.writeSSE({
          data: JSON.stringify({
            type: "device_list",
            devices: list.devices.map((d) => ({
              ...d,
              name: container.deviceNameStore.get(d.deviceId) ?? d.name,
            })),
          }),
          event: "device_list",
        });
      } catch {
        // Lookup failed — still emit an empty snapshot so the client stops
        // spinning and renders its empty state.
        await stream.writeSSE({
          data: JSON.stringify({ type: "device_list", devices: [] }),
          event: "device_list",
        });
      }

      // Listen for changes — broadcast immediately without re-checking
      // isAvailable(). The polling service already gates events on availability.
      const unsub = deviceEventEmitter.onChange(async (event) => {
        if (aborted) return;
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              type: event.type,
              deviceId: event.deviceId,
            }),
            event: event.type,
          });
        } catch {
          /* ignore — likely client disconnected */
        }
      });

      // Keep-alive ping every 15s
      while (!aborted) {
        await stream.writeSSE({ data: "ping", event: "ping" });
        await stream.sleep(15_000);
      }

      unsub();
    });
  });

  // POST /api/v1/devices/_internal/webhook — internal webhook for tabby-control
  app.post("/api/v1/devices/_internal/webhook", async (c) => {
    const body = await c.req.json<{ type: string; deviceId: string }>();
    if (body.type && body.deviceId) {
      deviceEventEmitter.emitChange({
        type: body.type as DeviceChangeEvent["type"],
        deviceId: body.deviceId,
      });
    }
    return c.json({ ok: true });
  });

  // ── LAN pairing (iTabby lan-pairing-protocol v1) ─────────────────────────────
  // tabby-control holds the requests and mints device keys; these routes only
  // proxy its loopback-only pairing RPC.

  // GET /api/v1/devices/pairing/requests — phones waiting for approval
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/devices/pairing/requests",
      tags: ["Device Control"],
      responses: {
        200: {
          content: {
            "application/json": { schema: devicePairingListResponseSchema },
          },
          description: "Pending pairing requests",
        },
      },
    }),
    async (c) => {
      // Polled app-wide: a plugin that is not running simply has nothing
      // pending, so this never turns into an error toast.
      try {
        const list = await container.deviceControlService.listPairingRequests();
        return c.json(list, 200);
      } catch {
        return c.json({ enabled: false, requests: [] }, 200);
      }
    },
  );

  for (const decision of ["approve", "reject"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/api/v1/devices/pairing/requests/{requestId}/${decision}`,
        tags: ["Device Control"],
        request: { params: pairingRequestParamSchema },
        responses: {
          200: {
            content: {
              "application/json": {
                schema: devicePairingDecisionResponseSchema,
              },
            },
            description:
              decision === "approve"
                ? "Pairing approved; the phone receives its keyed URL"
                : "Pairing rejected",
          },
          404: {
            content: { "application/json": { schema: errorSchema } },
            description: "Request expired, cancelled or already decided",
          },
          503: {
            content: { "application/json": { schema: errorSchema } },
            description: "Device control plugin is not running",
          },
        },
      }),
      async (c) => {
        const { requestId } = c.req.valid("param");
        try {
          if (decision === "approve") {
            await container.deviceControlService.approvePairingRequest(
              requestId,
            );
          } else {
            await container.deviceControlService.rejectPairingRequest(
              requestId,
            );
          }
          return c.json({ ok: true }, 200);
        } catch (err) {
          if (
            err instanceof DeviceControlRpcError &&
            err.code === "PAIRING_NOT_FOUND"
          ) {
            return c.json({ message: err.message }, 404);
          }
          return c.json(
            { message: "Device control plugin is not running" },
            503,
          );
        }
      },
    );
  }

  // POST /api/v1/devices/pairing/qr — keyed phone URL for the QR code
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/devices/pairing/qr",
      tags: ["Device Control"],
      responses: {
        200: {
          content: {
            "application/json": { schema: devicePairingQrResponseSchema },
          },
          description: "A freshly minted, single-device phone URL",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device control plugin is not running",
        },
      },
    }),
    async (c) => {
      try {
        const qr = await container.deviceControlService.createPairingQr();
        return c.json(qr, 200);
      } catch {
        return c.json({ message: "Device control plugin is not running" }, 503);
      }
    },
  );

  // GET /api/v1/devices — list devices
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/devices",
      tags: ["Device Control"],
      responses: {
        200: {
          content: { "application/json": { schema: deviceListResponseSchema } },
          description: "Device list",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device control plugin is not running",
        },
      },
    }),
    async (c) => {
      if (!(await container.deviceControlService.isAvailable())) {
        return c.json({ message: "Device control plugin is not running" }, 503);
      }

      const list = await container.deviceControlService.listDevices();
      return c.json(
        {
          devices: list.devices.map((d) => ({
            ...d,
            name: container.deviceNameStore.get(d.deviceId) ?? d.name,
          })),
        },
        200,
      );
    },
  );

  // GET /api/v1/devices/{deviceId} — get device
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/devices/{deviceId}",
      tags: ["Device Control"],
      request: { params: deviceIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: deviceInfoSchema } },
          description: "Device info",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device not found",
        },
      },
    }),
    async (c) => {
      const { deviceId } = c.req.valid("param");
      const device = await container.deviceControlService.getDevice(deviceId);

      if (device === null) {
        return c.json({ message: "Device not found" }, 404);
      }

      return c.json(
        {
          ...device,
          name: container.deviceNameStore.get(deviceId) ?? device.name,
        },
        200,
      );
    },
  );

  // PATCH /api/v1/devices/{deviceId} — rename device
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/devices/{deviceId}",
      tags: ["Device Control"],
      request: {
        params: renameParamSchema,
        body: {
          content: {
            "application/json": { schema: deviceRenameBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: deviceInfoSchema } },
          description: "Device renamed",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device not found",
        },
      },
    }),
    async (c) => {
      const { deviceId } = c.req.valid("param");
      const { name } = c.req.valid("json");
      container.deviceNameStore.set(deviceId, name);
      const device = await container.deviceControlService.getDevice(deviceId);
      if (device === null) {
        return c.json({ message: "Device not found" }, 404);
      }
      return c.json({ ...device, name }, 200);
    },
  );

  // POST /api/v1/devices/{deviceId}/tasks — execute task
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/devices/{deviceId}/tasks",
      tags: ["Device Control"],
      request: {
        params: deviceIdParamSchema,
        body: {
          content: {
            "application/json": { schema: deviceExecuteTaskBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: deviceExecuteTaskResponseSchema },
          },
          description: "Task result",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device not found",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device control plugin is not running",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Internal error",
        },
        504: {
          content: { "application/json": { schema: errorSchema } },
          description: "Task execution timed out",
        },
      },
    }),
    async (c) => {
      if (!(await container.deviceControlService.isAvailable())) {
        return c.json({ message: "Device control plugin is not running" }, 503);
      }

      const { deviceId } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const result = await container.deviceControlService.executeTask(
          deviceId,
          body,
        );
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRpcErrorToStatus(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // POST /api/v1/devices/{deviceId}/media — push images into the gallery
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/devices/{deviceId}/media",
      tags: ["Device Control"],
      request: {
        params: deviceIdParamSchema,
        body: {
          content: {
            "application/json": { schema: devicePushMediaBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: devicePushMediaResponseSchema },
          },
          description: "Per-image push results",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device not found",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device control plugin is not running",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Internal error",
        },
        504: {
          content: { "application/json": { schema: errorSchema } },
          description: "Media push timed out",
        },
      },
    }),
    async (c) => {
      if (!(await container.deviceControlService.isAvailable())) {
        return c.json({ message: "Device control plugin is not running" }, 503);
      }
      const { deviceId } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const result = await container.deviceControlService.pushMedia(
          deviceId,
          body,
        );
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRpcErrorToStatus(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );

  // DELETE /api/v1/devices/{deviceId}/tasks/{taskId} — cancel task
  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/devices/{deviceId}/tasks/{taskId}",
      tags: ["Device Control"],
      request: {
        params: taskIdParamSchema,
      },
      responses: {
        200: {
          content: { "application/json": { schema: cancelTaskResponseSchema } },
          description: "Task cancelled",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device or task not found",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Internal error",
        },
        503: {
          content: { "application/json": { schema: errorSchema } },
          description: "Device offline",
        },
        504: {
          content: { "application/json": { schema: errorSchema } },
          description: "Request timed out",
        },
      },
    }),
    async (c) => {
      const { deviceId, taskId } = c.req.valid("param");
      try {
        const result = await container.deviceControlService.cancelTask(
          deviceId,
          { taskId },
        );
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRpcErrorToStatus(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    },
  );
}
