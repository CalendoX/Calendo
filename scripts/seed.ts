/**
 * Development seed data. Creates two organizations (to demonstrate tenant isolation), users
 * for every role, availability schedules, event types, candidates and a spread of past and
 * upcoming interviews.
 *
 *   npm run db:seed          # no-op if seed data already exists
 *   npm run db:reset         # drop everything, migrate and seed again
 *
 * Credentials are for local development only — see README "Development credentials".
 */
import { config } from 'dotenv';
config({ quiet: true });

import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../src/server/auth/password';
import { closeDb, getDb } from '../src/server/db/client';
import {
  auditLogs,
  availabilityOverrides,
  availabilityRules,
  availabilitySchedules,
  candidates,
  eventTypes,
  interviewReschedules,
  interviews,
  memberships,
  organizationHolidays,
  organizations,
  users,
  videoMeetings,
  type CustomQuestion,
} from '../src/server/db/schema';
import { issueBookingTokens } from '../src/server/scheduling/booking-tokens';

const db = getDb();

export const SEED_USERS = {
  admin: { email: 'admin@northwind.test', password: 'Admin#Slate2026', name: 'Avery Chen', username: 'avery', title: 'Head of Talent', tz: 'America/New_York' },
  recruiter: { email: 'recruiter@northwind.test', password: 'Recruit#Slate2026', name: 'Jordan Rivera', username: 'jordan', title: 'Senior Technical Recruiter', tz: 'America/Chicago' },
  interviewer: { email: 'priya@northwind.test', password: 'Interview#Slate2026', name: 'Priya Nair', username: 'priya', title: 'Staff Software Engineer', tz: 'Europe/London' },
  interviewer2: { email: 'marcus@northwind.test', password: 'Interview#Slate2026', name: 'Marcus Webb', username: 'marcus', title: 'Engineering Manager', tz: 'America/Los_Angeles' },
  otherOrgAdmin: { email: 'admin@globex.test', password: 'Globex#Slate2026', name: 'Sam Okafor', username: 'sam', title: 'People Operations', tz: 'Europe/Berlin' },
} as const;

async function createUser(u: (typeof SEED_USERS)[keyof typeof SEED_USERS]) {
  const [row] = await db
    .insert(users)
    .values({
      email: u.email,
      name: u.name,
      username: u.username,
      title: u.title,
      timezone: u.tz,
      passwordHash: await hashPassword(u.password),
      emailVerifiedAt: new Date(),
      passwordChangedAt: new Date(Date.now() - 60_000),
      lastLoginAt: new Date(Date.now() - Math.floor(Math.random() * 5) * 86_400_000),
    })
    .returning();
  return row;
}

async function schedule(userId: string, organizationId: string, tz: string, weekly: Record<number, [string, string][]>, name = 'Working hours') {
  const [s] = await db.insert(availabilitySchedules).values({ organizationId, userId, name, timezone: tz, isDefault: name === 'Working hours' }).returning();
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const rows = Object.entries(weekly).flatMap(([day, ranges]) =>
    ranges.map(([a, b]) => ({ scheduleId: s.id, weekday: Number(day), startMinute: toMin(a), endMinute: toMin(b) })),
  );
  if (rows.length) await db.insert(availabilityRules).values(rows);
  return s;
}

/** The n-th business day from today (negative = past) in `tz`, at local `hh:mm`. */
function slot(tz: string, businessDays: number, time: string) {
  const step = businessDays >= 0 ? 1 : -1;
  let d = DateTime.now().setZone(tz).startOf('day');
  while (d.weekday > 5) d = d.plus({ days: step });
  for (let remaining = Math.abs(businessDays); remaining > 0; ) {
    d = d.plus({ days: step });
    if (d.weekday <= 5) remaining--;
  }
  const [h, m] = time.split(':').map(Number);
  return d.set({ hour: h, minute: m });
}

async function main() {
  const [existing] = await db.select().from(organizations).where(eq(organizations.slug, 'northwind-labs'));
  if (existing) {
    console.log('Seed data already present (organization "northwind-labs"). Run `npm run db:reset` to start fresh.');
    return;
  }

  console.log('→ Seeding organizations and users…');
  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Northwind Labs',
      slug: 'northwind-labs',
      brandColor: '#0e7c66',
      defaultTimezone: 'America/New_York',
      settings: {
        reminderOffsetsMinutes: [1440, 60],
        candidateCanReschedule: true,
        candidateCanCancel: true,
        candidateManageCutoffMinutes: 60,
        addCandidateAsCalendarAttendee: false,
        bookingPageNotice: 'Northwind Labs uses your details only to arrange and conduct this interview.',
      },
    })
    .returning();
  const [globex] = await db
    .insert(organizations)
    .values({ name: 'Globex Recruiting', slug: 'globex', brandColor: '#2563eb', defaultTimezone: 'Europe/Berlin', settings: { reminderOffsetsMinutes: [1440] } })
    .returning();

  const admin = await createUser(SEED_USERS.admin);
  const recruiter = await createUser(SEED_USERS.recruiter);
  const priya = await createUser(SEED_USERS.interviewer);
  const marcus = await createUser(SEED_USERS.interviewer2);
  const sam = await createUser(SEED_USERS.otherOrgAdmin);

  await db.insert(memberships).values([
    { organizationId: org.id, userId: admin.id, role: 'admin' },
    { organizationId: org.id, userId: recruiter.id, role: 'recruiter', invitedById: admin.id },
    { organizationId: org.id, userId: priya.id, role: 'interviewer', invitedById: admin.id },
    { organizationId: org.id, userId: marcus.id, role: 'interviewer', invitedById: admin.id },
    { organizationId: globex.id, userId: sam.id, role: 'admin' },
  ]);

  console.log('→ Seeding availability…');
  const weekdays = (ranges: [string, string][]) => ({ 1: ranges, 2: ranges, 3: ranges, 4: ranges, 5: ranges });
  await schedule(admin.id, org.id, SEED_USERS.admin.tz, weekdays([['09:00', '17:00']]));
  const jordanSched = await schedule(recruiter.id, org.id, SEED_USERS.recruiter.tz, { ...weekdays([['08:30', '12:00'], ['13:00', '16:30']]), 5: [['08:30', '12:00']] });
  await schedule(priya.id, org.id, SEED_USERS.interviewer.tz, { ...weekdays([['09:30', '12:30'], ['13:30', '17:30']]), 5: [['09:30', '15:00']] });
  const priyaLoops = await schedule(priya.id, org.id, SEED_USERS.interviewer.tz, { 2: [['10:00', '16:00']], 4: [['10:00', '16:00']] }, 'Onsite loops');
  await schedule(marcus.id, org.id, SEED_USERS.interviewer2.tz, weekdays([['10:00', '18:00']]));
  await schedule(sam.id, globex.id, SEED_USERS.otherOrgAdmin.tz, weekdays([['09:00', '17:00']]));

  // A vacation day and a custom-hours day for Jordan; a company holiday.
  const vacation = slot(SEED_USERS.recruiter.tz, 9, '00:00').toISODate()!;
  const shortDay = slot(SEED_USERS.recruiter.tz, 10, '00:00').toISODate()!;
  await db.insert(availabilityOverrides).values([
    { scheduleId: jordanSched.id, date: vacation, startMinute: null, endMinute: null, note: 'Vacation' },
    { scheduleId: jordanSched.id, date: shortDay, startMinute: 9 * 60, endMinute: 12 * 60, note: 'Offsite in the afternoon' },
  ]);
  await db.insert(organizationHolidays).values({ organizationId: org.id, date: slot('America/New_York', 20, '00:00').toISODate()!, name: 'Company recharge day' });

  console.log('→ Seeding event types…');
  const techQuestions: CustomQuestion[] = [
    { id: 'q_experience', label: 'How many years of professional software engineering experience do you have?', type: 'short_text', required: true },
    { id: 'q_language', label: 'Preferred language for the coding exercise', type: 'single_select', required: true, options: ['TypeScript', 'Python', 'Go', 'Java', 'Kotlin'] },
    { id: 'q_access', label: 'Anything we should know to make the interview accessible for you?', type: 'long_text', required: false },
  ];
  const [tech, sysDesign, screen, culture, hm] = await db
    .insert(eventTypes)
    .values([
      {
        organizationId: org.id,
        hostUserId: priya.id,
        slug: 'technical-interview',
        name: 'Technical Interview',
        description: 'A 60-minute pairing session. We’ll work through a practical coding problem together in a shared editor — no trick questions, and you can use your preferred language.',
        color: '#0e7c66',
        durationMinutes: 60,
        locationType: 'zoom',
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
        minimumNoticeMinutes: 24 * 60,
        maxDaysInFuture: 30,
        questions: techQuestions,
        fieldConfig: { phone: 'optional', company: 'optional', linkedinUrl: 'optional', resumeUrl: 'required' },
      },
      {
        organizationId: org.id,
        hostUserId: priya.id,
        scheduleId: priyaLoops.id,
        slug: 'system-design',
        name: 'System Design Interview',
        description: 'A 90-minute architecture discussion for senior candidates.',
        color: '#7c3aed',
        durationMinutes: 90,
        locationType: 'zoom',
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
        minimumNoticeMinutes: 48 * 60,
        maxDaysInFuture: 21,
        visibility: 'link_only',
        dailyLimit: 2,
      },
      {
        organizationId: org.id,
        hostUserId: recruiter.id,
        slug: 'phone-screen',
        name: 'Recruiter Phone Screen',
        description: 'A friendly 30-minute conversation about your background, what you’re looking for, and the role.',
        color: '#2563eb',
        durationMinutes: 30,
        locationType: 'phone',
        locationDetails: 'Jordan will call you at the number you provide',
        minimumNoticeMinutes: 4 * 60,
        maxDaysInFuture: 21,
        slotIntervalMinutes: 30,
        fieldConfig: { phone: 'required', company: 'optional', linkedinUrl: 'optional', resumeUrl: 'optional' },
        questions: [{ id: 'q_notice', label: 'What is your notice period?', type: 'short_text', required: false }],
      },
      {
        organizationId: org.id,
        hostUserId: recruiter.id,
        slug: 'culture-chat',
        name: 'Culture & Values Chat',
        description: 'Meet the team at our office for coffee and a conversation about how we work.',
        color: '#db2777',
        durationMinutes: 45,
        locationType: 'in_person',
        locationDetails: 'Northwind Labs HQ, 500 Market Street, 4th floor, San Francisco',
        minimumNoticeMinutes: 24 * 60,
        maxDaysInFuture: 30,
        bufferAfterMinutes: 15,
        isActive: true,
      },
      {
        organizationId: org.id,
        hostUserId: admin.id,
        slug: 'hiring-manager',
        name: 'Hiring Manager Interview',
        description: 'Talk with the hiring manager about the team, the roadmap and your experience.',
        color: '#ea580c',
        durationMinutes: 45,
        locationType: 'zoom',
        minimumNoticeMinutes: 24 * 60,
        maxDaysInFuture: 45,
        bufferAfterMinutes: 10,
      },
    ])
    .returning();
  await db.insert(eventTypes).values({
    organizationId: globex.id,
    hostUserId: sam.id,
    slug: 'intro-call',
    name: 'Intro Call',
    durationMinutes: 30,
    locationType: 'phone',
    locationDetails: 'We will call you',
    minimumNoticeMinutes: 60,
  });

  console.log('→ Seeding candidates and interviews…');
  const people = [
    ['Maya Thompson', 'maya.thompson@example.com', 'America/New_York'],
    ['Diego Alvarez', 'diego.alvarez@example.com', 'America/Mexico_City'],
    ['Hannah Kim', 'hannah.kim@example.com', 'Asia/Seoul'],
    ['Oliver Bennett', 'oliver.bennett@example.com', 'Europe/London'],
    ['Aisha Rahman', 'aisha.rahman@example.com', 'Asia/Dubai'],
    ['Lucas Moreau', 'lucas.moreau@example.com', 'Europe/Paris'],
    ['Grace Liu', 'grace.liu@example.com', 'America/Los_Angeles'],
    ['Tomás Silva', 'tomas.silva@example.com', 'America/Sao_Paulo'],
    ['Nina Petrova', 'nina.petrova@example.com', 'Europe/Berlin'],
    ['Ethan Brooks', 'ethan.brooks@example.com', 'America/Chicago'],
  ] as const;
  const cands = await db
    .insert(candidates)
    .values(
      people.map(([name, email, tz], i) => ({
        organizationId: org.id,
        name,
        email,
        timezone: tz,
        phone: i % 2 === 0 ? `+1 415 555 01${String(i).padStart(2, '0')}` : null,
        linkedinUrl: `https://www.linkedin.com/in/${email.split('@')[0].replace('.', '-')}`,
        resumeUrl: i % 3 === 0 ? `https://files.example.com/resumes/${email.split('@')[0]}.pdf` : null,
        company: ['Acme Corp', 'Initech', 'Hooli', null, 'Pied Piper'][i % 5],
      })),
    )
    .returning();

  type Plan = {
    et: typeof tech;
    host: typeof priya;
    tz: string;
    cand: number;
    day: number;
    time: string;
    status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
    rescheduledFrom?: { day: number; time: string };
    cancelReason?: string;
  };
  const plans: Plan[] = [
    { et: tech, host: priya, tz: SEED_USERS.interviewer.tz, cand: 0, day: 1, time: '10:00', status: 'scheduled' },
    { et: tech, host: priya, tz: SEED_USERS.interviewer.tz, cand: 3, day: 2, time: '14:00', status: 'rescheduled', rescheduledFrom: { day: 1, time: '15:00' } },
    { et: tech, host: priya, tz: SEED_USERS.interviewer.tz, cand: 5, day: 4, time: '11:00', status: 'scheduled' },
    { et: sysDesign, host: priya, tz: SEED_USERS.interviewer.tz, cand: 8, day: 6, time: '10:15', status: 'scheduled' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 1, day: 0, time: '15:30', status: 'scheduled' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 6, day: 1, time: '09:00', status: 'scheduled' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 9, day: 3, time: '13:30', status: 'scheduled' },
    { et: culture, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 2, day: 5, time: '10:00', status: 'cancelled', cancelReason: 'Candidate accepted another offer' },
    { et: hm, host: admin, tz: SEED_USERS.admin.tz, cand: 4, day: 2, time: '11:00', status: 'scheduled' },
    { et: hm, host: admin, tz: SEED_USERS.admin.tz, cand: 7, day: 3, time: '15:00', status: 'scheduled' },
    // Past
    { et: tech, host: priya, tz: SEED_USERS.interviewer.tz, cand: 6, day: -3, time: '10:00', status: 'completed' },
    { et: tech, host: priya, tz: SEED_USERS.interviewer.tz, cand: 9, day: -5, time: '14:00', status: 'no_show' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 0, day: -8, time: '10:00', status: 'completed' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 3, day: -7, time: '11:00', status: 'completed' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 5, day: -6, time: '09:30', status: 'completed' },
    { et: hm, host: admin, tz: SEED_USERS.admin.tz, cand: 1, day: -2, time: '13:00', status: 'completed' },
    { et: screen, host: recruiter, tz: SEED_USERS.recruiter.tz, cand: 8, day: -4, time: '14:00', status: 'cancelled', cancelReason: 'Scheduling conflict' },
  ];

  for (const p of plans) {
    const start = slot(p.tz, p.day, p.time);
    const startAt = start.toJSDate();
    const endAt = start.plus({ minutes: p.et.durationMinutes }).toJSDate();
    const cand = cands[p.cand];
    const active = p.status === 'scheduled' || p.status === 'rescheduled';
    const [iv] = await db
      .insert(interviews)
      .values({
        organizationId: org.id,
        eventTypeId: p.et.id,
        hostUserId: p.host.id,
        candidateId: cand.id,
        title: `${p.et.name}: ${cand.name}`,
        startAt,
        endAt,
        bufferBeforeMinutes: p.et.bufferBeforeMinutes,
        bufferAfterMinutes: p.et.bufferAfterMinutes,
        timezone: p.tz,
        candidateTimezone: cand.timezone ?? p.tz,
        status: p.status,
        locationType: p.et.locationType,
        locationDetails: p.et.locationDetails,
        responses:
          p.et.id === tech.id
            ? [
                { questionId: 'q_experience', label: techQuestions[0].label, answer: `${3 + p.cand} years` },
                { questionId: 'q_language', label: techQuestions[1].label, answer: ['TypeScript', 'Python', 'Go'][p.cand % 3] },
              ]
            : [],
        source: 'public_page',
        version: p.status === 'rescheduled' ? 2 : p.status === 'cancelled' ? 2 : 1,
        rescheduleCount: p.status === 'rescheduled' ? 1 : 0,
        cancelReason: p.cancelReason ?? null,
        cancelledAt: p.status === 'cancelled' ? new Date(Date.now() - 86_400_000) : null,
        cancelledByType: p.status === 'cancelled' ? 'candidate' : null,
        completedAt: p.status === 'completed' ? endAt : null,
        createdAt: new Date(Math.min(Date.now(), startAt.getTime()) - 5 * 86_400_000),
      })
      .returning();
    await issueBookingTokens(db, iv.id, iv.startAt, iv.endAt);
    if (p.et.locationType === 'zoom') {
      await db.insert(videoMeetings).values({
        organizationId: org.id,
        interviewId: iv.id,
        provider: 'zoom',
        status: active ? 'failed' : 'cancelled',
        lastError: active ? 'Zoom is not connected for this interviewer.' : null,
      });
    }
    await db.insert(auditLogs).values({
      organizationId: org.id,
      actorType: 'candidate',
      actorLabel: `${cand.name} <${cand.email}>`,
      action: 'interview.created',
      resourceType: 'interview',
      resourceId: iv.id,
      metadata: { eventType: p.et.name, candidateEmail: cand.email, start: iv.startAt.toISOString(), source: 'public_page' },
      createdAt: iv.createdAt,
    });
    if (p.rescheduledFrom) {
      const prev = slot(p.tz, p.rescheduledFrom.day, p.rescheduledFrom.time);
      await db.insert(interviewReschedules).values({
        organizationId: org.id,
        interviewId: iv.id,
        previousStartAt: prev.toJSDate(),
        previousEndAt: prev.plus({ minutes: p.et.durationMinutes }).toJSDate(),
        newStartAt: iv.startAt,
        newEndAt: iv.endAt,
        actorType: 'candidate',
        reason: 'A family commitment came up — thank you for the flexibility!',
      });
      await db.insert(auditLogs).values({
        organizationId: org.id,
        actorType: 'candidate',
        actorLabel: `${cand.name} <${cand.email}>`,
        action: 'interview.rescheduled',
        resourceType: 'interview',
        resourceId: iv.id,
        metadata: { previousStart: prev.toUTC().toISO(), newStart: iv.startAt.toISOString(), reason: 'A family commitment came up — thank you for the flexibility!', via: 'candidate_token' },
      });
    }
    if (p.status === 'cancelled') {
      await db.insert(auditLogs).values({
        organizationId: org.id,
        actorType: 'candidate',
        actorLabel: `${cand.name} <${cand.email}>`,
        action: 'interview.cancelled',
        resourceType: 'interview',
        resourceId: iv.id,
        metadata: { reason: p.cancelReason, via: 'candidate_token' },
      });
    }
  }

  await db.insert(auditLogs).values([
    { organizationId: org.id, actorType: 'user', actorUserId: admin.id, action: 'organization.created', resourceType: 'organization', resourceId: org.id, metadata: { name: org.name } },
    { organizationId: org.id, actorType: 'user', actorUserId: admin.id, action: 'user.created', resourceType: 'user', resourceId: recruiter.id, metadata: { email: recruiter.email, role: 'recruiter' } },
    { organizationId: org.id, actorType: 'user', actorUserId: admin.id, action: 'user.created', resourceType: 'user', resourceId: priya.id, metadata: { email: priya.email, role: 'interviewer' } },
    { organizationId: org.id, actorType: 'user', actorUserId: admin.id, action: 'user.created', resourceType: 'user', resourceId: marcus.id, metadata: { email: marcus.email, role: 'interviewer' } },
    { organizationId: org.id, actorType: 'user', actorUserId: priya.id, action: 'event_type.created', resourceType: 'event_type', resourceId: tech.id, metadata: { name: tech.name, durationMinutes: 60 } },
  ]);

  console.log('\n✓ Seed complete. Development credentials:\n');
  for (const [role, u] of Object.entries(SEED_USERS)) {
    console.log(`  ${role.padEnd(14)} ${u.email.padEnd(28)} ${u.password}`);
  }
  console.log('\n  Public booking page: /schedule/priya/technical-interview\n');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('✗ Seed failed:', err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
