import { useEffect, useState } from 'react';

/** In-app two-click confirmation (native confirm() blocks and is ugly). */
export function ConfirmButton({
  label,
  confirmLabel,
  busyLabel,
  busy,
  disabled,
  className,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  className: string;
  onConfirm: () => void;
}) {
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), 4000);
    return () => clearTimeout(t);
  }, [arming]);
  if (busy) {
    return (
      <button className={className} disabled>
        <Spinner /> {busyLabel ?? label}
      </button>
    );
  }
  return (
    <button
      className={`${className} ${arming ? '!border-amber-500/60 !text-amber-300' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (arming) {
          setArming(false);
          onConfirm();
        } else {
          setArming(true);
        }
      }}
    >
      {arming ? confirmLabel : label}
    </button>
  );
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]" />;
}
