import { Garmin } from 'garminconnect'; // npm install garminconnect
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import path from 'path';
import os from 'os';

const TOKEN_PATH = path.join(os.homedir(), '.garminconnect');

export async function getGarminClient() {
  const client = new Garmin(
    process.env.GARMIN_EMAIL!,
    process.env.GARMIN_PASSWORD!,
    { prompt_mfa: () => Promise.resolve(process.env.GARMIN_MFA ?? '') }
  );
  await client.login(TOKEN_PATH);
  return client;
}

export async function fetchGarminActivities(limit = 50) {
  const client = await getGarminClient();
  return client.getActivities(0, limit);
}

export async function fetchGarminLaps(garminActivityId: number) {
  const client = await getGarminClient();
  const splits = await client.getActivitySplits(garminActivityId);
  return splits?.lapDTOs ?? [];
}