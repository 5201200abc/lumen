type IconProps = { size?: number };

export function IconPlus({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconGear({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.67 2.74a2.25 2.25 0 0 1 4.66 0l.18.88a2.25 2.25 0 0 0 3.02 1.62l.84-.3a2.25 2.25 0 0 1 2.33 4.04l-.66.6a2.25 2.25 0 0 0 0 3.84l.66.6a2.25 2.25 0 0 1-2.33 4.04l-.84-.3a2.25 2.25 0 0 0-3.02 1.62l-.18.88a2.25 2.25 0 0 1-4.66 0l-.18-.88a2.25 2.25 0 0 0-3.02-1.62l-.84.3a2.25 2.25 0 0 1-2.33-4.04l.66-.6a2.25 2.25 0 0 0 0-3.84l-.66-.6a2.25 2.25 0 0 1 2.33-4.04l.84.3a2.25 2.25 0 0 0 3.02-1.62l.18-.88Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.15" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconArrowUp({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 13V3M3.75 7.25 8 3l4.25 4.25" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconStop({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden>
      <rect x="1" y="1" width="8" height="8" rx="0.8" />
    </svg>
  );
}

export function IconCopy({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconCheck({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconTrash({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.2 4.2h9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6 4.2V3.1h4v1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.4 4.2l.6 9h5.9l.6-9" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.6 6.6v5.2M9.4 6.6v5.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconRefresh({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  );
}

export function IconGlobe({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.8 8h10.4M8 2.8c-1.6 1.8-2.4 3.5-2.4 5.2S6.4 11.4 8 13.2M8 2.8c1.6 1.8 2.4 3.5 2.4 5.2S9.6 11.4 8 13.2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
