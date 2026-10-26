import { useRelativeTimeState } from "../hooks/useRelativeTimeState";

// Use a live clock because the compiler caches inline formatting on the timestamp.
export function RelativeTime(props: { timestamp: string; compact?: boolean }) {
  const relative = useRelativeTimeState(props.timestamp);
  if (relative.status !== "relative") return null;
  return relative.suffix && !props.compact
    ? `${relative.value} ${relative.suffix}`
    : relative.value;
}
