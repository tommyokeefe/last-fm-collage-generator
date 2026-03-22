import { formatMetric } from "./lastfm";
import type { AlbumEntry, RankingMode } from "../types";

export async function renderExportBlob(
  albums: AlbumEntry[],
  rows: number,
  columns: number,
  rankingMode: RankingMode,
): Promise<Blob> {
  const tileSize = 500;
  const canvas = document.createElement("canvas");
  canvas.width = columns * tileSize;
  canvas.height = rows * tileSize;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The browser could not create a canvas export context.");
  }

  context.fillStyle = "#08111f";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < albums.length; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = column * tileSize;
    const y = row * tileSize;
    await drawAlbumTile(context, albums[index] as AlbumEntry, x, y, tileSize, index + 1, rankingMode);
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });

  if (!blob) {
    throw new Error("PNG export failed.");
  }

  return blob;
}

async function drawAlbumTile(
  context: CanvasRenderingContext2D,
  album: AlbumEntry,
  x: number,
  y: number,
  tileSize: number,
  rank: number,
  rankingMode: RankingMode,
): Promise<void> {
  context.save();
  context.strokeStyle = "rgba(255, 255, 255, 0.08)";
  context.strokeRect(x, y, tileSize, tileSize);

  if (album.imageUrl) {
    try {
      const image = await loadImage(album.imageUrl);
      context.drawImage(image, x, y, tileSize, tileSize);
    } catch (error) {
      console.warn("Could not load album art for export", album, error);
      drawPlaceholderTile(context, album, x, y, tileSize);
    }
  } else {
    drawPlaceholderTile(context, album, x, y, tileSize);
  }

  context.fillStyle = "rgba(7, 17, 31, 0.84)";
  roundRect(context, x + 16, y + 16, 68, 40, 20);
  context.fill();
  context.fillStyle = "#eef2ff";
  context.font = "700 20px Inter, sans-serif";
  context.fillText(`#${rank}`, x + 29, y + 41);

  const gradient = context.createLinearGradient(0, y + tileSize - 160, 0, y + tileSize);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0.88)");
  context.fillStyle = gradient;
  context.fillRect(x, y + tileSize - 160, tileSize, 160);

  context.fillStyle = "#eef2ff";
  context.font = "700 28px Inter, sans-serif";
  drawWrappedText(context, album.album, x + 24, y + tileSize - 88, tileSize - 48, 34, 2);
  context.font = "500 22px Inter, sans-serif";
  context.fillStyle = "#d6e0ff";
  drawWrappedText(context, album.artist, x + 24, y + tileSize - 28, tileSize - 48, 28, 1);

  context.font = "500 18px Inter, sans-serif";
  context.fillStyle = "#d6e0ff";
  context.fillText(formatMetric(album, rankingMode), x + 24, y + tileSize - 128);
  context.restore();
}

function drawPlaceholderTile(
  context: CanvasRenderingContext2D,
  album: AlbumEntry,
  x: number,
  y: number,
  tileSize: number,
): void {
  const gradient = context.createLinearGradient(x, y, x + tileSize, y + tileSize);
  gradient.addColorStop(0, "rgba(124, 156, 255, 0.45)");
  gradient.addColorStop(1, "rgba(42, 68, 146, 0.7)");
  context.fillStyle = gradient;
  context.fillRect(x, y, tileSize, tileSize);

  context.fillStyle = "rgba(255, 255, 255, 0.1)";
  context.beginPath();
  context.arc(x + tileSize * 0.74, y + tileSize * 0.3, tileSize * 0.18, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#eef2ff";
  context.font = "700 36px Inter, sans-serif";
  drawWrappedText(context, album.album, x + 28, y + tileSize * 0.48, tileSize - 56, 42, 3);
  context.font = "500 26px Inter, sans-serif";
  context.fillStyle = "#d6e0ff";
  drawWrappedText(context, album.artist, x + 28, y + tileSize * 0.72, tileSize - 56, 30, 2);
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  const visibleLines = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const lastLine = visibleLines[maxLines - 1];
    if (lastLine) {
      visibleLines[maxLines - 1] = `${lastLine.replace(/[.,;:!?-]*$/, "")}...`;
    }
  }

  visibleLines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${src}`));
    image.src = src;
  });
}
