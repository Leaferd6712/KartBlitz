export type CapturedLap = {
  lapIndex: number; stage: string; lapTime: number; lapKind: string;
  frames: number[][]; sampleRateHz: number; initialState: Record<string, unknown>;
  controlEvents: number[][]; stateCheckpoints: unknown[]; traffic: unknown[];
  inputEncoding: string; frameFields: string[];
};
export class PlayerLapRecorder {
  observe(options: { kart: any; input?: any; time: number; stage?: string; opponents?: any[] }): CapturedLap | null;
}
