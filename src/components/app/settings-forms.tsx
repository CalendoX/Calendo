'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api-client';

export function ProfileForm({ initial, appUrl }: { initial: { name: string; title: string | null; timezone: string; username: string; email: string }; appUrl: string }) {
  const router = useRouter();
  const [v, setV] = useState({ ...initial, title: initial.title ?? '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader title="Profile" description="Shown to candidates on your booking pages and in emails." />
      <CardBody>
        <form
          className="grid gap-5 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            try {
              await api('/api/me', { method: 'PATCH', body: { name: v.name, title: v.title || null, timezone: v.timezone, username: v.username } });
              toast.success('Profile updated');
              router.refresh();
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fieldErrors);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Full name" htmlFor="p-name" error={errors.name}>
            <Input id="p-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
          </Field>
          <Field label="Job title" htmlFor="p-title" optionalTag error={errors.title}>
            <Input id="p-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Engineering Manager" />
          </Field>
          <Field label="Email" hint="Contact an administrator to change your email.">
            <Input value={v.email} disabled readOnly />
          </Field>
          <Field label="Username" htmlFor="p-username" error={errors.username} hint={`${appUrl.replace(/^https?:\/\//, '')}/schedule/${v.username}`}>
            <Input id="p-username" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} required />
          </Field>
          <Field label="Time zone" hint="Used for your dashboard, calendar and emails." error={errors.timezone}>
            <TimezoneSelect value={v.timezone} onChange={(tz) => setV({ ...v, timezone: tz })} />
          </Field>
          <div className="flex items-end justify-end md:col-span-2">
            <Button type="submit" loading={busy}>
              Save profile
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function PasswordForm() {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader title="Password" description="Changing your password signs you out on all other devices." />
      <CardBody>
        <form
          className="grid gap-5 md:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const d = new FormData(form);
            setErrors({});
            if (d.get('newPassword') !== d.get('confirm')) {
              setErrors({ confirm: 'Passwords do not match' });
              return;
            }
            setBusy(true);
            try {
              await api('/api/me/password', { body: { currentPassword: d.get('currentPassword'), newPassword: d.get('newPassword') } });
              toast.success('Password changed');
              form.reset();
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fieldErrors);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Current password" htmlFor="currentPassword" error={errors.currentPassword}>
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="New password" htmlFor="newPassword" error={errors.newPassword} hint="At least 10 characters.">
            <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm" error={errors.confirm}>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <div className="flex justify-end md:col-span-3">
            <Button type="submit" variant="secondary" loading={busy}>
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
