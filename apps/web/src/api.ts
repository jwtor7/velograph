/** Typed client for the loopback API. Same-origin only; never an external host. */

export interface WorkoutSummary {
  id: number;
  type: string;
  startUtc: number;
  endUtc: number;
  durationS: number;
  qualityState: string;
  distanceM: number | null;
  avgSpeedMs: number | null;
  avgHr: number | null;
  elevationGainM: number | null;
  hasRoute: boolean;
}

export interface MetricSample {
  t: number;
  value: number;
  min?: number;
  max?: number;
}

export interface RoutePoint {
  t: number;
  lat: number;
  lon: number;
  ele?: number;
  speed?: number;
}

export interface ZoneTime {
  zone: number;
  label: string;
  seconds: number;
  share: number;
}

export interface Split {
  index: number;
  kind: 'km' | 'time';
  startOffsetS: number;
  durationS: number;
  distanceM: number | null;
  avgSpeedMs: number | null;
  avgHr: number | null;
}

export interface RideAnalytics {
  formulaVersion: string;
  workoutId: number;
  durationS: number;
  movingTimeS: number | null;
  distanceM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  heartRate: {
    avg: number | null;
    max: number | null;
    min: number | null;
    coverage: number | null;
  };
  cadence: { avg: number | null; max: number | null; min: number | null; coverage: number | null };
  energyKj: number | null;
  elevation: {
    gainM: number | null;
    lossM: number | null;
    minM: number | null;
    maxM: number | null;
  };
  zones: ZoneTime[] | null;
  efficiency: number | null;
  decouplingPct: number | null;
  pacingVariability: number | null;
  splits: Split[];
  unavailable: Record<string, string>;
}

export interface WorkoutDetail {
  workout: { id: number; type: string; startUtc: number; endUtc: number };
  metrics: Partial<Record<'heart_rate' | 'cadence' | 'distance' | 'energy', MetricSample[]>>;
  route: { points: RoutePoint[] }[];
  analytics: RideAnalytics | null;
}

export interface TrendsResponse {
  rides: {
    id: number;
    startUtc: number;
    durationS: number;
    distanceM: number | null;
    avgHr: number | null;
    avgSpeedMs: number | null;
    efficiency: number | null;
    zones: ZoneTime[] | null;
    elevationGainM: number | null;
  }[];
  weekly: { weekStartUtc: number; rideCount: number; distanceM: number; durationS: number }[];
}

export interface Settings {
  hrZoneBounds: number[] | null;
  movingSpeedThresholdMs: number;
  minCoverageForEfficiency: number;
  elevationHysteresisM: number;
}

export interface ImportResultBody {
  batchId: number;
  imported: number;
  skippedDuplicates: number;
  quarantined: number;
  workoutsCreated: number;
  workoutsUpdated: number;
  quarantinedFiles: { name: string; code: string }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-velograph-request': '1',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`api_${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  workouts: () => request<{ workouts: WorkoutSummary[] }>('/api/workouts'),
  workout: (id: number) => request<WorkoutDetail>(`/api/workouts/${id}`),
  trends: () => request<TrendsResponse>('/api/trends'),
  settings: () => request<{ settings: Settings }>('/api/settings'),
  saveSettings: (settings: Partial<Settings>) =>
    request<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),
  importFiles: (files: { name: string; dataBase64: string }[]) =>
    request<{ result: ImportResultBody }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({ files }),
    }),
};
