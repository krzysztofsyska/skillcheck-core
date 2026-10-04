"use client";
import { useFormStatus } from "react-dom";
export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? "Proszę czekać…" : children}</button>;
}
