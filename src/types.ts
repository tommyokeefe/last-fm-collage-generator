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
}

export interface MissingArtworkEntry {
  artist: string;
  album: string;
  albumKey: string;
  sourceArtist: string;
  sourceAlbum: string;
  sourceKey: string;
}

export interface AlbumEntry {
  artist: string;
  artistNames: Set<string>;
  album: string;
  imageUrl: string;
  playCount: number;
  approximateListeningMs: number;
  trackCount: number | null;
  albumDurationMs: number | null;
  sourceArtist: string;
  sourceAlbum: string;
  sourceKey: string;
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

export interface LastFmAlbumInfoResponse {
  album?: {
    image?: LastFmImage[];
  };
}

export interface LastFmErrorResponse {
  error: number;
  message?: string;
}

export interface LastFmTopAlbum {
  name: LastFmTextField;
  playcount?: string;
  artist: LastFmTextField;
  image?: LastFmImage[];
}

export interface LastFmTopAlbumsResponse {
  topalbums: {
    album: LastFmTopAlbum[] | LastFmTopAlbum;
    "@attr"?: {
      totalPages?: string;
    };
  };
}

export interface AlbumMetadata {
  trackCount: number;
  albumDurationMs: number;
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

export interface ResolveMissingArtworkResult {
  missingArtwork: MissingArtworkEntry[];
  resolvedCount: number;
}
