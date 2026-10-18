"use client";

import { useEffect, useRef, type ReactNode } from "react";

export default function Modal({ children, onClose, label, wide = false }: {
  children: ReactNode;
  onClose: () => void;
  label: string;
  wide?: boolean;
}) {
  const surface = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const target = surface.current?.querySelector<HTMLElement>("input:not(:disabled), button, select:not(:disabled), textarea");
      (target ?? surface.current)?.focus();
    });
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab" || !surface.current) return;
      const controls = Array.from(surface.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      )).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); surface.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !surface.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !surface.current.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) close.current();
  }}>
    <section ref={surface} className={`modal${wide ? " detail-modal" : ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      {children}
    </section>
  </div>;
}
