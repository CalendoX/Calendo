'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { browserTimeZone } from '@/lib/time';

function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  return {
    errors,
    formError,
    reset() {
      setErrors({});
      setFormError(null);
    },
    fromError(err: unknown) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        setErrors(err.fieldErrors);
        setFormError(err.message);
      } else setFormError(errorMessage(err));
    },
  };
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const f = useFieldErrors();
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        f.reset();
        setBusy(true);
        try {
          await api('/api/auth/login', { body: { email: data.get('email'), password: data.get('password') } });
          router.push(next);
          router.refresh();
        } catch (err) {
          f.fromError(err);
          setBusy(false);
        }
      }}
    >
      {f.formError && <Alert tone="error">{f.formError}</Alert>}
      <Field label="Work email" htmlFor="email" error={f.errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Field
        label={
          <span className="flex items-center justify-between">
            Password
            <Link href="/forgot-password" className="text-xs font-medium text-brand-700 hover:underline">
              Forgot password?
            </Link>
          </span>
        }
        htmlFor="password"
        error={f.errors.password}
      >
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

export function SignupForm() {
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const f = useFieldErrors();
  useEffect(() => setTimezone(browserTimeZone()), []);
  if (requested) {
    return (
      <Alert tone="success" title="Request received">
        Thanks! Your account is waiting for approval. We’ll email <strong>{requested}</strong> as soon as it’s approved. Meanwhile, please confirm your email address
        using the link we just sent.
      </Alert>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        f.reset();
        setBusy(true);
        try {
          // New accounts wait for a platform admin's approval before they can sign in.
          await api('/api/auth/signup', {
            body: {
              name: data.get('name'),
              email: data.get('email'),
              password: data.get('password'),
              organizationName: data.get('organizationName'),
              timezone,
            },
          });
          setRequested(String(data.get('email') ?? ''));
        } catch (err) {
          f.fromError(err);
          setBusy(false);
        }
      }}
    >
      {f.formError && <Alert tone="error">{f.formError}</Alert>}
      <Field label="Full name" htmlFor="name" error={f.errors.name}>
        <Input id="name" name="name" autoComplete="name" required autoFocus />
      </Field>
      <Field label="Work email" htmlFor="email" error={f.errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Company" htmlFor="organizationName" error={f.errors.organizationName}>
        <Input id="organizationName" name="organizationName" autoComplete="organization" required />
      </Field>
      <Field label="Password" htmlFor="password" error={f.errors.password} hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Field label="Time zone" htmlFor="timezone">
        <TimezoneSelect id="timezone" value={timezone} onChange={setTimezone} />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Request account
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const f = useFieldErrors();
  if (sent) {
    return (
      <Alert tone="success" title="Check your inbox">
        If an account exists for <strong>{sent}</strong>, we’ve sent a link to reset your password. It expires in one hour.
      </Alert>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const email = String(new FormData(e.currentTarget).get('email') ?? '');
        f.reset();
        setBusy(true);
        try {
          await api('/api/auth/forgot-password', { body: { email } });
          setSent(email);
        } catch (err) {
          f.fromError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {f.formError && <Alert tone="error">{f.formError}</Alert>}
      <Field label="Work email" htmlFor="email" error={f.errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const f = useFieldErrors();
  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Password updated">
          You’ve been signed out everywhere. Sign in with your new password.
        </Alert>
        <Button className="w-full" size="lg" onClick={() => router.push('/login')}>
          Continue to sign in
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        f.reset();
        if (data.get('password') !== data.get('confirm')) {
          f.fromError(new ApiError(422, 'VALIDATION_ERROR', 'Passwords do not match.', { confirm: ['Passwords do not match'] }));
          return;
        }
        setBusy(true);
        try {
          await api('/api/auth/reset-password', { body: { token, password: data.get('password') } });
          setDone(true);
        } catch (err) {
          f.fromError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {f.formError && <Alert tone="error">{f.formError}</Alert>}
      <Field label="New password" htmlFor="password" error={f.errors.password} hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={f.errors.confirm}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Update password
      </Button>
    </form>
  );
}

export function AcceptInviteForm({ token, name, email }: { token: string; name: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [timezone, setTimezone] = useState('UTC');
  const f = useFieldErrors();
  useEffect(() => setTimezone(browserTimeZone()), []);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        f.reset();
        setBusy(true);
        try {
          await api('/api/auth/accept-invite', { body: { token, name: data.get('name'), password: data.get('password'), timezone } });
          router.push('/dashboard?welcome=1');
          router.refresh();
        } catch (err) {
          f.fromError(err);
          setBusy(false);
        }
      }}
    >
      {f.formError && <Alert tone="error">{f.formError}</Alert>}
      <Field label="Email">
        <Input value={email} disabled readOnly />
      </Field>
      <Field label="Full name" htmlFor="name" error={f.errors.name}>
        <Input id="name" name="name" defaultValue={name} autoComplete="name" required />
      </Field>
      <Field label="Choose a password" htmlFor="password" error={f.errors.password} hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required autoFocus />
      </Field>
      <Field label="Time zone" htmlFor="timezone">
        <TimezoneSelect id="timezone" value={timezone} onChange={setTimezone} />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Join and continue
      </Button>
    </form>
  );
}

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('');
  useEffect(() => {
    api('/api/auth/verify-email', { body: { token } })
      .then(() => setState('done'))
      .catch((err) => {
        setMessage(errorMessage(err));
        setState('error');
      });
  }, [token]);
  if (state === 'working') return <p className="text-sm text-zinc-500">Verifying your email…</p>;
  if (state === 'error') return <Alert tone="error" title="Verification failed">{message}</Alert>;
  return (
    <div className="space-y-4">
      <Alert tone="success" title="Email verified">Your booking pages are now live.</Alert>
      <Button asChild className="w-full" size="lg">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </div>
  );
}
