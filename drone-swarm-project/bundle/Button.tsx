type ButtonProps = JSX.IntrinsicElements['button'] & {
  /** `primary` is filled. `ghost` is low emphasis. The default is outline. */
  variant?: 'default' | 'primary' | 'ghost';
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
  const base =
    variant === 'primary'
      ? 'dsp-btn dsp-btn-primary'
      : variant === 'ghost'
        ? 'dsp-btn dsp-btn-ghost'
        : 'dsp-btn';
  return (
    <button className={className ? `${base} ${className}` : base} {...rest} />
  );
}
