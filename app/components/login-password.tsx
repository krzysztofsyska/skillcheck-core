"use client";

import { useState } from "react";

export function LoginPassword() {
  const [visible, setVisible] = useState(false);
  return <div className="password-field">
    <label htmlFor="login-password">Hasło</label>
    <input id="login-password" name="password" type={visible ? "text" : "password"}
      autoComplete="current-password" required maxLength={256} autoCapitalize="none" spellCheck={false} />
    <button type="button" className="password-toggle" aria-controls="login-password"
      aria-pressed={visible} onClick={() => setVisible(value => !value)}>
      {visible ? "Ukryj hasło" : "Pokaż hasło"}
    </button>
  </div>;
}
