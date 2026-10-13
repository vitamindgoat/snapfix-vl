"use client";

import { FormEvent, useState } from "react";
import {
  clearLoginAccessToken,
  getLoginAccessToken,
  loginMalexTenant,
} from "@/lib/malex";

type Props = {
  children: React.ReactNode;
};

/**
 * Optional Track B gate: if a login session exists, use it.
 * Unattended demos still work via `/_malex/ui/session` without logging in.
 * Sign-in is offered when auth is required or the user chooses to log in.
 */
export function MalexLoginBar({ children }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authed, setAuthed] = useState(() => !!getLoginAccessToken());
  const [showForm, setShowForm] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await loginMalexTenant(email, password);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAuthed(true);
      setShowForm(false);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const onLogout = () => {
    clearLoginAccessToken();
    setAuthed(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-zinc-600">
        {authed ? (
          <>
            <span className="text-zinc-500">Signed in</span>
            <button
              type="button"
              onClick={onLogout}
              className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50"
          >
            {showForm ? "Hide sign in" : "Sign in"}
          </button>
        )}
      </div>
      {showForm && !authed && (
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-700">
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-700">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {error && (
            <p className="basis-full text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {children}
    </div>
  );
}
