"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound, ShieldCheck, GitBranch, Search, UserRound, CheckCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";

const demos = [
  { name: "Morgan Chen", role: "Support admin", email: "morgan@newtonite.local", password: "Morgan2026!" },
  { name: "Jordan Patel", role: "Team lead", email: "jordan@newtonite.local", password: "Jordan2026!" },
  { name: "Casey Rivera", role: "Team member", email: "casey@newtonite.local", password: "Casey2026!" },
  { name: "Taylor Brooks", role: "Payments member", email: "taylor@newtonite.local", password: "Taylor2026!" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.replace("/");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Unable to sign in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-brand-panel">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div><div className="brand-name">Newtonite</div><div className="brand-caption">Operations workbench</div></div>
        </div>
        <div className="login-panel-copy">
          <div className="eyebrow">One shared picture of work</div>
          <h1>Good work starts with clear ownership.</h1>
          <p>Keep urgent requests visible, decisions close to the work, and every handoff easy to follow.</p>
          <div className="login-visual" aria-label="A shared journey from investigation to resolution"><div className="login-visual-heading"><GitBranch size={13} />A shared journey, from start to finish</div><div className="login-visual-flow"><span><Search size={17} /></span><ArrowRight size={14} /><span><UserRound size={17} /></span><ArrowRight size={14} /><span><CheckCheck size={17} /></span></div><p>Investigate · Take ownership · Resolve together</p></div>
        </div>
        <div className="login-proof">Team work, made clear · Newtonite internal tools</div>
      </section>
      <section className="login-main">
        <div className="login-card">
          <div className="eyebrow">Welcome back</div>
          <h2>Sign in to your workspace</h2>
          <p>Use your work account to continue to the team queue.</p>
          <form onSubmit={submit}>
            <div className="login-fields">
              <div className="field"><label htmlFor="email">Email address</label><input id="email" className="field-control" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></div>
              <div className="field"><label htmlFor="password">Password</label><input id="password" className="field-control" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></div>
            </div>
            {error && <div className="field-error" role="alert">{error}</div>}
            <button className="primary-button lime login-button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}<ArrowRight size={15} /></button>
          </form>
          <div className="demo-box">
            <div className="demo-box-title"><KeyRound size={13} /> Choose a demo account</div>
            <div className="demo-accounts">
              {demos.map((demo) => <button className={`demo-account${email === demo.email ? " is-selected" : ""}`} aria-pressed={email === demo.email} key={demo.email} type="button" onClick={() => { setEmail(demo.email); setPassword(demo.password); setError(""); }}><strong>{demo.name}</strong><span>{demo.role}</span></button>)}
            </div>
          </div>
          <div className="login-note"><ShieldCheck size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} /> Demo credentials are for local assessment use. Passwords are stored as salted hashes.</div>
        </div>
      </section>
    </main>
  );
}
