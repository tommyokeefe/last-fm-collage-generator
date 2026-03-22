import type { CSSProperties } from "react";

export type RankingMode = "plays" | "listening-time";
export type StatusTone = "info" | "success" | "error";
export type TimeRangeValue = "7d" | "1m" | "3m" | "6m" | "12m" | "overall";
export type GridSize =
  | "3x3"
  | "4x4"
  | "5x5"
  | "6x6"
  | "7x7"
  | "8x8"
  | "9x9"
  | "10x10";

export interface Settings {
  username: string;
  timeRange: TimeRangeValue;
  gridSize: GridSize;
  rankingMode: RankingMode;
  showAlbumInfo: boolean;
  showMetric: boolean;
}

export interface StatusState {
  tone: StatusTone;
  message: string;
  progress?: FetchProgressState;
}

export interface SummaryState {
  scrobbles: number;
  albums: number;
  pages: number;
  durationGaps: number;
}

export interface AlbumTrack {
  artist: string;
  album: string;
  name: string;
  plays: number;
}

export interface MissingDurationEntry extends AlbumTrack {
  trackKey: string;
  checkedAt: number;
}

export interface AlbumEntry {
  artist: string;
  artistNames: Set<string>;
  album: string;
  imageUrl: string;
  playCount: number;
  approximateListeningMs: number;
  tracks: Map<string, AlbumTrack>;
}

export interface TimeRange {
  label: TimeRangeValue;
  from?: number;
  to?: number;
}

export interface LastFmImage {
  size?: string;
  "#text"?: string;
}

export interface LastFmDate {
  uts?: string;
}

export type LastFmTextField =
  | string
  | {
      "#text"?: string;
      name?: string;
      mbid?: string;
    };

export interface LastFmRecentTrack {
  artist: LastFmTextField;
  album: LastFmTextField;
  name: LastFmTextField;
  image?: LastFmImage[];
  date?: LastFmDate;
}

export interface LastFmRecentTracksResponse {
  recenttracks: {
    track: LastFmRecentTrack[] | LastFmRecentTrack;
    "@attr"?: {
      totalPages?: string;
    };
  };
}

export interface LastFmTrackInfoResponse {
  track?: {
    duration?: string;
  };
}

export interface LastFmErrorResponse {
  error: number;
  message?: string;
}

export interface RecentTracksResult {
  items: LastFmRecentTrack[];
  pagesFetched: number;
}

export interface RecentTracksResumeState {
  nextPage: number;
  totalPages: number;
}

export interface FetchProgressState {
  completed: number;
  total: number;
  estimatedRemainingMs: number;
  unitLabel: string;
}

export type PreviewGridStyle = CSSProperties & {
  "--columns": number;
};

export interface ExportRenderOptions {
  showAlbumInfo: boolean;
  showMetric: boolean;
}

export interface HydrateListeningTimesResult {
  missingDurations: MissingDurationEntry[];
}

export interface ResolveMissingDurationsResult {
  missingDurations: MissingDurationEntry[];
  resolvedCount: number;
}
