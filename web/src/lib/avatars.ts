import { useSyncExternalStore } from 'react';

/** Merkt sich, welche Benutzer ein Profilbild haben (Versionsnummer > 0 und Bild hinterlegt). */
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
let tick = 0;

export function setAvatarVersions(list: { id: string; avatarVersion?: number | null; hasAvatar?: boolean }[]) {
  for (const u of list) versions.set(u.id, u.hasAvatar ? (u.avatarVersion ?? 1) : 0);
  tick++;
  listeners.forEach((l) => l());
}

export function useAvatarUrl(id: string | null | undefined, hasImage: (id: string) => boolean = () => true): string | null {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => tick);
  if (!id) return null;
  const v = versions.get(id);
  return v && hasImage(id) ? `/api/users/${id}/avatar?v=${v}` : null;
}
