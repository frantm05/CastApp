import { create } from 'zustand';

export interface DLNADevice {
  usn: string;
  friendlyName: string;
  location: string;
  controlURL: string;
  modelName?: string;
}

export interface ExtractedStream {
  url: string;
  type: 'm3u8' | 'mp4' | 'unknown';
  timestamp: number;
  pageUrl: string;
}

interface AppState {
  // Stream extraction
  extractedStreams: ExtractedStream[];
  selectedStream: ExtractedStream | null;
  addStream: (stream: ExtractedStream) => void;
  selectStream: (stream: ExtractedStream | null) => void;
  clearStreams: () => void;

  // DLNA devices
  devices: DLNADevice[];
  selectedDevice: DLNADevice | null;
  isScanning: boolean;
  setDevices: (devices: DLNADevice[]) => void;
  addDevice: (device: DLNADevice) => void;
  selectDevice: (device: DLNADevice | null) => void;
  setScanning: (scanning: boolean) => void;

  // Casting state
  isCasting: boolean;
  castingStatus: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  setCasting: (casting: boolean) => void;
  setCastingStatus: (status: AppState['castingStatus']) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Stream extraction
  extractedStreams: [],
  selectedStream: null,
  addStream: (stream) =>
    set((state) => {
      // Avoid duplicates
      const exists = state.extractedStreams.some((s) => s.url === stream.url);
      if (exists) return state;
      console.log('[Store] New stream added:', stream.url);
      return { extractedStreams: [...state.extractedStreams, stream] };
    }),
  selectStream: (stream) => set({ selectedStream: stream }),
  clearStreams: () => set({ extractedStreams: [], selectedStream: null }),

  // DLNA devices
  devices: [],
  selectedDevice: null,
  isScanning: false,
  setDevices: (devices) => set({ devices }),
  addDevice: (device) =>
    set((state) => {
      const exists = state.devices.some((d) => d.usn === device.usn);
      if (exists) return state;
      console.log('[Store] New DLNA device found:', device.friendlyName);
      return { devices: [...state.devices, device] };
    }),
  selectDevice: (device) => set({ selectedDevice: device }),
  setScanning: (scanning) => set({ isScanning: scanning }),

  // Casting state
  isCasting: false,
  castingStatus: 'idle',
  setCasting: (casting) => set({ isCasting: casting }),
  setCastingStatus: (status) => set({ castingStatus: status }),
}));
