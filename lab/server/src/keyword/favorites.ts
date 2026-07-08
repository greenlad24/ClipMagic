/**
 * Favorites contract for the Keyword Research tool.
 *
 * A personal, persistent library organized into FOLDERS (one per project/report).
 * Each folder holds saved TITLES (winning competitor video titles the user liked)
 * and saved KEYWORDS (a favorite-keywords database). Keywords are added by:
 *   - manually EXTRACTING them from saved titles (AI, on demand),
 *   - starring a keyword row straight from the results table,
 *   - or adding one by hand.
 * Titles and keywords can carry a note + tags. All of it lives in SQLite
 * (kw_fav_folders / kw_fav_titles / kw_fav_keywords) — see db/favorites.ts.
 */

export interface FavFolder {
  id: string;
  name: string;
  /** Live counts for the folder chips (filled by listFavFolders). */
  titleCount: number;
  keywordCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FavTitle {
  id: string;
  folderId: string;
  title: string;
  videoId: string | null;
  channelTitle: string | null;
  views: number | null;
  subscriberCount: number | null;
  publishedAt: string | null;
  /** The research keyword whose competitor list surfaced this title. */
  sourceKeyword: string | null;
  note: string | null;
  tags: string[];
  createdAt: number;
}

/** How a favorite keyword entered the database. */
export type FavKeywordSource = "extracted" | "table" | "manual";

export interface FavKeyword {
  id: string;
  folderId: string;
  keyword: string;
  source: FavKeywordSource;
  /** The favorite title an "extracted" keyword came from, when applicable. */
  sourceTitleId: string | null;
  note: string | null;
  tags: string[];
  createdAt: number;
}

/** Everything in one folder (returned by getFavorites). */
export interface FavoritesView {
  folder: FavFolder;
  titles: FavTitle[];
  keywords: FavKeyword[];
}
