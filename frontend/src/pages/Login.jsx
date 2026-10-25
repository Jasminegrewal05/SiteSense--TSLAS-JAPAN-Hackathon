import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { Wordmark } from "../components/AppShell";
import { Button, Field, Notice, inputClass } from "../components/ui";

export default function Login() {
  const { user, loading, loginWithPassword, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [config, setConfig] = useState({ local_login: true, google_client_id: "" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const goTo = location.state?.from || "/";

  useEffect(() => {
    api.authConfig().then(setConfig).catch(() => {});
  }, []);

  if (!loading && user) return <Navigate to={goTo} replace />;

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await loginWithPassword(email, password);
      navigate(goTo, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function google(response) {
    setError("");
    setBusy(true);
    try {
      await loginWithGoogle(response.credential);
      navigate(goTo, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-white">
      <section className="hidden lg:grid place-items-center bg-ink text-white px-14 py-12">
        <div className="text-center">
          <div className="relative inline-block px-14 py-10">
            {/* viewfinder corners: what the glasses see */}
            <span className="absolute left-0 top-0 w-10 h-10 border-l-4 border-t-4 border-white/70 rounded-tl-lg" />
            <span className="absolute right-0 top-0 w-10 h-10 border-r-4 border-t-4 border-white/70 rounded-tr-lg" />
            <span className="absolute left-0 bottom-0 w-10 h-10 border-l-4 border-b-4 border-white/70 rounded-bl-lg" />
            <span className="absolute right-0 bottom-0 w-10 h-10 border-r-4 border-b-4 border-white/70 rounded-br-lg" />
            <span className="block text-[5.5rem] leading-none font-bold tracking-tight">SiteSense</span>
          </div>
          <p className="mt-8 text-2xl text-white/85">Better judgment on every site visit.</p>
        </div>
      </section>

      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <Wordmark className="text-5xl text-ink lg:hidden" />
          <h1 className="text-3xl font-bold mt-8 lg:mt-0">Sign in</h1>
          <p className="text-sub text-lg mt-1 mb-8">Use your company account.</p>

          {config.local_login && (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Work email">
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="name@company.com"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Button type="submit" busy={busy} className="w-full">
                Sign in
              </Button>
            </form>
          )}

          {config.google_client_id && (
            <>
              {config.local_login && (
                <div className="flex items-center gap-3 my-6 text-xs text-sub">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <GoogleOAuthProvider clientId={config.google_client_id}>
                <div className={busy ? "opacity-50 pointer-events-none" : ""}>
                  <GoogleLogin
                    onSuccess={google}
                    onError={() => setError("Google sign-in was cancelled or failed.")}
                    text="signin_with"
                    width="384"
                  />
                </div>
              </GoogleOAuthProvider>
            </>
          )}

          {error && (
            <Notice tone="high" className="mt-5">
              {error}
            </Notice>
          )}

        </div>
      </section>
    </div>
  );
}
