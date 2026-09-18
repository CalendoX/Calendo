import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db/client';
import { interviews } from '@/server/db/schema';
import { NotFoundError } from '@/server/http/errors';

export async function loadInterviewRow(id: string) {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError('Interview not found');
  const [row] = await db.select().from(interviews).where(eq(interviews.id, id)).limit(1);
  if (!row) throw new NotFoundError('Interview not found');
  return row;
}
