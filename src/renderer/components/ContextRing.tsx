import { useState } from "react";

type Props = {
  used: number;
  total: number;
};

function formatTokens(n: number): string {
  if (n <= 0) return "0";
  if (n < 1000) return `${n}`;
  return `${(n / 1024).toFixed(1)}k`;
}

export function ContextRing({ used, total }: Props) {
  const [hovered, setHovered] = useState(false);
  const max = total > 0 ? total : 16384;
  const current = Math.max(0, used || 0);
  const ratio = Math.min(1, current / max);
  const percent = Math.round(ratio * 100);

  const size = 18;
  const strokeWidth = 2.2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - ratio * circumference;

  let strokeColor = "var(--fg)";
  if (percent >= 85) strokeColor = "#ef4444";
  else if (percent >= 60) strokeColor = "#f59e0b";
  else strokeColor = "var(--user-fg, #888888)";

  return (
    <div
      className="context-ring-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`上下文窗口: ${formatTokens(current)} / ${formatTokens(max)} (${percent}%)`}
    >
      <div className="context-ring-btn">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="context-svg">
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--line)"
            strokeWidth={strokeWidth}
          />
          {/* Progress circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{
              transform: "rotate(-90deg)",
              transformOrigin: "50% 50%",
              transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease"
            }}
          />
        </svg>
        <span className="context-percent-label">{percent}%</span>
      </div>

      {hovered && (
        <div className="context-tooltip">
          <div className="context-tooltip-title">上下文窗口</div>
          <div className="context-tooltip-row">
            <span>已用 Token</span>
            <strong>{current.toLocaleString()} ({formatTokens(current)})</strong>
          </div>
          <div className="context-tooltip-row">
            <span>窗口上限</span>
            <span>{max.toLocaleString()} ({formatTokens(max)})</span>
          </div>
          <div className="context-tooltip-row">
            <span>占用比例</span>
            <strong style={{ color: strokeColor }}>{percent}%</strong>
          </div>
        </div>
      )}
    </div>
  );
}
