import { useEffect, useRef } from "react";
import emblem from "../public/logo.svg?raw";

export function StudioIntro({ onFinish }: { onFinish: () => void }) {
  const finish = useRef(onFinish);
  const skip = useRef<HTMLButtonElement>(null);
  useEffect(() => { finish.current = onFinish; }, [onFinish]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const close = () => finish.current();
    const motionChanged = () => { if (media.matches) close(); };
    const keyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    skip.current?.focus({ preventScroll: true });
    motionChanged();
    const timer = window.setTimeout(close, 2750);
    media.addEventListener("change", motionChanged);
    window.addEventListener("keydown", keyDown);
    return () => { clearTimeout(timer); media.removeEventListener("change", motionChanged); window.removeEventListener("keydown", keyDown); };
  }, []);
  return <div className="studio-intro" role="dialog" aria-modal="true" aria-label="Вход в медиацентр Виолетта">
    <div className="intro-signature">
      <div className="intro-symbol" aria-hidden="true" dangerouslySetInnerHTML={{ __html: emblem }} />
      <div className="intro-name">ВИОЛЕТТА<small>Делаем как себе</small></div>
    </div>
    <button ref={skip} className="skip-signature" onClick={onFinish}>Перейти в приложение <span aria-hidden="true">↗</span></button>
  </div>;
}
