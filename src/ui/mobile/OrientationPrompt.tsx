import "./OrientationPrompt.css";

interface Props {
  visible: boolean;
}

export function OrientationPrompt({ visible }: Props) {
  if (!visible) return null;
  return (
    <div className="orientation-prompt" role="dialog" aria-modal="true">
      <div className="orientation-card">
        <div className="orientation-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="72" height="72">
            <rect
              x="10" y="18" width="44" height="28" rx="4"
              fill="none" stroke="currentColor" strokeWidth="3"
            />
            <circle cx="48" cy="32" r="1.6" fill="currentColor" />
            <path
              d="M20 56 Q32 60 44 56"
              fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path
              d="M42 52 L46 56 L42 60"
              fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2 className="orientation-title">Please rotate your device</h2>
        <p className="orientation-body">
          This game is best played in landscape. Turn your phone sideways to
          continue.
        </p>
      </div>
    </div>
  );
}
