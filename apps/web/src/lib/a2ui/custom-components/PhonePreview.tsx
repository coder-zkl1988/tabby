import { Wifi, WifiOff } from "lucide-react";
import { useState } from "react";
import type { CustomComponentProps } from "./registry";

interface DeviceInfo {
  name: string;
  model?: string;
  status?: "online" | "offline" | "busy";
  screenshot?: string;
}

export function PhonePreview({ comp, resolve }: CustomComponentProps) {
  const raw = resolve((comp as { devices?: DeviceInfo[] }).devices) as
    | DeviceInfo[]
    | null;
  const devices = Array.isArray(raw) ? raw : [];

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <div className="a2ui-phone-empty">
        <span>No connected devices</span>
      </div>
    );
  }

  return (
    <div className="a2ui-phone-preview">
      {devices.map((device, i) => {
        const isOnline = device.status === "online";
        const isExpanded = expandedId === `${i}`;

        return (
          <div
            key={device.name || `${i}`}
            className={`a2ui-phone-card ${isExpanded ? "a2ui-phone-card--expanded" : ""}`}
          >
            <button
              type="button"
              className="a2ui-phone-card__header"
              onClick={() => setExpandedId(isExpanded ? null : `${i}`)}
            >
              <div className="a2ui-phone-card__info">
                {isOnline ? (
                  <Wifi
                    size={14}
                    className="a2ui-phone-card__status-icon--online"
                  />
                ) : (
                  <WifiOff
                    size={14}
                    className="a2ui-phone-card__status-icon--offline"
                  />
                )}
                <span className="a2ui-phone-card__name">{device.name}</span>
                {device.model && (
                  <span className="a2ui-phone-card__model">{device.model}</span>
                )}
              </div>
              <span
                className={`a2ui-phone-card__status ${isOnline ? "a2ui-phone-card__status--online" : "a2ui-phone-card__status--offline"}`}
              >
                {isOnline ? "Online" : "Offline"}
              </span>
            </button>

            {isExpanded && device.screenshot && (
              <div className="a2ui-phone-card__screenshot">
                <img
                  src={device.screenshot}
                  alt={`${device.name} screenshot`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
