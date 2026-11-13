type ButtonProps = JSX.IntrinsicElements['button'] & {
  /** `primary` is the filled style. The default is the outline style. */
  variant?: 'default' | 'primary';
};

/**
 * A button with the bundle's own style.
 *
 * The bundle cannot import the host's Button component, so it applies the shared
 * `dsp-btn` classes instead.
 */
export function Button({
  variant = 'default',
  className,
  ...rest
}: ButtonProps) {
  const base = variant === 'primary' ? 'dsp-btn dsp-btn-primary' : 'dsp-btn';
  return (
    <button className={className ? `${base} ${className}` : base} {...rest} />
  );
}
