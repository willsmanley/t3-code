import { useEffect, useRef, useState } from "react";

/**
 * Fork (F16): the composer's ✓ finishes the dictation and sends the message. The send waits for
 * the render that holds the transcript, because the composer's send checks read rendered state.
 */
export function useDictationSend(stop: () => Promise<boolean>, send: () => void): () => void {
  const pending = useRef(false);
  const [sendRequest, setSendRequest] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends once the composer has rendered the committed transcript, which its send checks read
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    send();
  }, [
    send,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each request is one send, after its render
    sendRequest,
  ]);
  return () =>
    void stop().then((committed) => {
      if (!committed) return;
      pending.current = true;
      setSendRequest((request) => request + 1);
    });
}
