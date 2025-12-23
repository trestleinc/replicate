import { Status, StatusLabels, type StatusValue } from "../types/interval";

const statusColors: Record<StatusValue, string> = {
  [Status.BACKLOG]: "#6b7280", // gray-500
  [Status.TODO]: "#3b82f6", // blue-500
  [Status.IN_PROGRESS]: "#f59e0b", // amber-500
  [Status.DONE]: "#22c55e", // green-500
  [Status.CANCELED]: "#ef4444", // red-500
};

interface StatusIconProps {
  status: StatusValue;
  size?: number;
  className?: string;
}

export function StatusIcon({ status, size = 14, className = "" }: StatusIconProps) {
  const color = statusColors[status];
  const label = StatusLabels[status];

  // Different icon for each status
  if (status === Status.DONE) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.5" fill={color} />
        <path
          d="M5 8l2 2 4-4"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === Status.CANCELED) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.5" />
        <path d="M5 8h6" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (status === Status.IN_PROGRESS) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.5" />
        <path d="M8 1a7 7 0 0 1 0 14" fill={color} stroke={color} strokeWidth="1.5" />
      </svg>
    );
  }

  // Default circle for BACKLOG and TODO
  const fillOpacity = status === Status.TODO ? 0.15 : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle
        cx="8"
        cy="8"
        r="7"
        stroke={color}
        strokeWidth="1.5"
        fill={color}
        fillOpacity={fillOpacity}
      />
    </svg>
  );
}
