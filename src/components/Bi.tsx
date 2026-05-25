export function Bi({ name, className = '' }: { name: string; className?: string }) {
  return <i className={`bi bi-${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
