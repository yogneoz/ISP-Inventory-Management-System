/**
 * Departments view of the Organizational Chart, drawn as a Miro-style board.
 *
 * Why a board instead of nested lists: the reference structure is a picture —
 * CEO → COO fanned out over seven department columns. Here every post
 * is a small absolutely-positioned card and the hierarchy is drawn with SVG
 * elbow connectors, so the reader can pan, zoom, and click a card to see the
 * people standing in that post plus the department it belongs to.
 *
 * The board is still derived, never edited: it renders the same catalogue and
 * branch-scoped employee rows as the Tree and Grades views.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  FileDown,
  Hand,
  Maximize,
  Maximize2,
  Minimize,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Users,
  X,
} from 'lucide-react';
import { api } from '../../services/api';
import type {
  HrOrgCatalogue,
  HrOrgChartEmployee,
  HrOrgDepartmentCatalogueRow,
  HrOrgDesignationCatalogueRow,
} from '../../services/api';

const CARD_W = 180;
const CARD_H = 86;
const COL_W = 236;
const ROW_H = 98;
const MARGIN = 24;
const DEPT_HEADER_H = 28;
const CEO_Y = 0;
const COO_Y = 96;
const DEPT_Y_MIN = 220;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 1.8;
/** Space kept under the viewport for the collapsed build-notes strip and page padding. */
const BOTTOM_RESERVE = 56;

export interface BoardCard {
  key: string;
  kind: 'DEPARTMENT' | 'DESIGNATION';
  row: HrOrgDesignationCatalogueRow | null;
  dept: HrOrgDepartmentCatalogueRow | null;
  x: number;
  y: number;
  w: number;
  h: number;
  parentKey: string | null;
  dotted: boolean;
}

export interface BoardLink {
  from: string;
  to: string;
  kind: 'STRAIGHT' | 'ELBOW' | 'RAIL' | 'HORIZONTAL';
  dotted: boolean;
}

export interface BoardLayout {
  width: number;
  height: number;
  cards: BoardCard[];
  links: BoardLink[];
}

const DEPT_HEADER_KEY = (id: string) => `dept:${id}`;
const POST_KEY = (id: string) => `post:${id}`;

const GRADE_ORDER: Record<string, number> = {
  G10: 10, G9: 9, G8: 8, G7: 7, G6: 6, G5: 5, G4: 4, G3: 3, G2: 2, G1: 1,
};

const gradeRank = (grade: string | null): number => (grade ? GRADE_ORDER[grade] ?? 0 : 0);

/**
 * Pure layout function so the structure can be unit-tested without a browser.
 * Every designation in the catalogue lands on exactly one card.
 */
export function buildBoardLayout(catalogue: HrOrgCatalogue): BoardLayout {
  const designations = catalogue.designations;
  const cards: BoardCard[] = [];
  const links: BoardLink[] = [];

  const ceo =
    designations.find((row) => row.code === 'DES-01') ??
    designations.find((row) => !row.reportsToId && /chief executive/i.test(row.name));
  const coo =
    designations.find((row) => row.code === 'DES-02') ??
    designations.find((row) => row.reportsToId === ceo?.id && /operations/i.test(row.name));

  /** Leadership posts are drawn in the top band, not inside a department column. */
  const leadership = new Set<string>();
  if (ceo) leadership.add(ceo.id);
  if (coo) leadership.add(coo.id);

  const advisors = designations.filter(
    (row) => !row.reportsToId && Boolean(row.reportsToLabel) && row.id !== ceo?.id
  );
  const ceoStaff = designations.filter(
    (row) => row.reportsToId === ceo?.id && row.id !== coo?.id
  );
  advisors.concat(ceoStaff).forEach((row) => leadership.add(row.id));

  const deptPosts = catalogue.departments
    .map((dept) => ({
      dept,
      posts: designations.filter((row) => row.departmentId === dept.id && !leadership.has(row.id)),
    }))
    .filter((entry) => entry.posts.length > 0);

  const width = Math.max(deptPosts.length * COL_W + MARGIN * 2, 980);
  const centerX = Math.round(width / 2 - CARD_W / 2);

  const card = (
    kind: BoardCard['kind'],
    key: string,
    x: number,
    y: number,
    w: number,
    h: number,
    row: HrOrgDesignationCatalogueRow | null,
    dept: HrOrgDepartmentCatalogueRow | null
  ) => {
    const next: BoardCard = { key, kind, row, dept, x, y, w, h, parentKey: null, dotted: false };
    cards.push(next);
    return next;
  };

  // The governance "start" card is deliberately not drawn: the board begins at
  // the CEO, which leaves the departments more vertical room. The Board still
  // shows as the external root in the Tree view.
  // A branch-scoped catalogue may not include the CEO; then the department
  // columns stand on their own.
  const ceoCard = ceo ? card('DESIGNATION', POST_KEY(ceo.id), centerX, CEO_Y, CARD_W, CARD_H, ceo, null) : null;

  const cooCard = coo ? card('DESIGNATION', POST_KEY(coo.id), centerX, COO_Y, CARD_W, CARD_H, coo, null) : null;
  if (cooCard && ceoCard) links.push({ from: ceoCard.key, to: cooCard.key, kind: 'STRAIGHT', dotted: false });

  // Advisory / CEO-office posts sit beside the CEO, as in the reference sheet.
  const leftAdvisors = advisors.filter((row) => /legal|consult/i.test(row.name));
  const rightAdvisors = advisors.filter((row) => !leftAdvisors.includes(row));
  leftAdvisors.forEach((row, index) => {
    const advisor = card(
      'DESIGNATION',
      POST_KEY(row.id),
      Math.max(MARGIN / 2, centerX - CARD_W - 72),
      CEO_Y + index * ROW_H,
      CARD_W,
      CARD_H,
      row,
      null
    );
    advisor.dotted = true;
    if (ceoCard) links.push({ from: ceoCard.key, to: advisor.key, kind: 'HORIZONTAL', dotted: true });
  });
  rightAdvisors.concat(ceoStaff).forEach((row, index) => {
    const advisor = card(
      'DESIGNATION',
      POST_KEY(row.id),
      centerX + CARD_W + 72,
      CEO_Y + index * ROW_H,
      CARD_W,
      CARD_H,
      row,
      null
    );
    const isDotted = !row.reportsToId && /board/i.test(row.reportsToLabel || '');
    advisor.dotted = isDotted;
    if (ceoCard) links.push({ from: ceoCard.key, to: advisor.key, kind: 'HORIZONTAL', dotted: isDotted });
  });

  // A large leadership band (more CEO-office posts) must not be overlapped by
  // the department columns, so the columns start below the lowest top card.
  const leadershipBottom = cards.reduce((max, current) => Math.max(max, current.y + current.h), 0);
  const deptY =
    ceoCard || cooCard ? Math.max(DEPT_Y_MIN, leadershipBottom + 44) : 40;

  for (const [index, entry] of deptPosts.entries()) {
    const colX = MARGIN + index * COL_W;
    const deptCard = card(
      'DEPARTMENT',
      DEPT_HEADER_KEY(entry.dept.id),
      colX,
      deptY,
      CARD_W,
      DEPT_HEADER_H,
      null,
      entry.dept
    );
    if (cooCard) links.push({ from: cooCard.key, to: deptCard.key, kind: 'RAIL', dotted: false });

    const ids = new Set(entry.posts.map((row) => row.id));
    const childrenOf = (id: string) =>
      entry.posts
        .filter((row) => row.reportsToId === id)
        .sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade) || a.name.localeCompare(b.name));
    const visited = new Set<string>();
    const ordered: Array<{ row: HrOrgDesignationCatalogueRow; depth: number }> = [];
    const walk = (row: HrOrgDesignationCatalogueRow, depth: number) => {
      if (visited.has(row.id)) return;
      visited.add(row.id);
      ordered.push({ row, depth });
      childrenOf(row.id).forEach((child) => walk(child, depth + 1));
    };
    const head =
      entry.posts.find((row) => row.id === entry.dept.headId) ??
      entry.posts.find((row) => !row.reportsToId || !ids.has(row.reportsToId)) ??
      entry.posts[0];
    walk(head, 0);
    entry.posts
      .filter((row) => !visited.has(row.id))
      .sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade) || a.name.localeCompare(b.name))
      .forEach((row) => walk(row, 0));

    ordered.forEach(({ row, depth }, rowIndex) => {
      const post = card(
        'DESIGNATION',
        POST_KEY(row.id),
        colX + Math.min(depth, 4) * 12,
        deptY + DEPT_HEADER_H + 10 + rowIndex * ROW_H,
        CARD_W,
        CARD_H,
        row,
        entry.dept
      );
      post.parentKey = row.reportsToId && ids.has(row.reportsToId) ? POST_KEY(row.reportsToId) : deptCard.key;
    });
  }

  for (const post of cards) {
    if (!post.parentKey) continue;
    const parent = cards.find((candidate) => candidate.key === post.parentKey);
    if (!parent) continue;
    links.push({
      from: parent.key,
      to: post.key,
      kind: parent.kind === 'DEPARTMENT' ? 'STRAIGHT' : 'ELBOW',
      dotted: false,
    });
  }

  const height = cards.reduce((max, current) => Math.max(max, current.y + current.h), 0) + 56;
  return { width, height, cards, links };
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
  );

/**
 * Standalone A3 landscape HTML of the board, used for "Export PDF". The
 * browser's print dialog writes the PDF, so no heavy client PDF dependency is
 * pulled into the bundle; links and card positions are the on-screen ones.
 */
export function buildBoardPrintHtml(
  layout: BoardLayout,
  placed: BoardCard[],
  people: Map<string, string[]>,
  linkRoutes: BoardLinkRoutes = {}
): string {
  const byKey = new Map(placed.map((card) => [card.key, card]));
  const paths = layout.links
    .map((link) => {
      const from = byKey.get(link.from);
      const to = byKey.get(link.to);
      if (!from || !to) return '';
      const lane = linkRoutes[`${link.from}->${link.to}`] ?? 0;
      return `<path d="${linkPath(from, to, link.kind, lane)}" fill="none" stroke="${link.dotted ? '#94a3b8' : '#2563eb'}" stroke-width="1.5"${link.dotted ? ' stroke-dasharray="5 4"' : ''} />`;
    })
    .join('');

  const cards = placed
    .map((card) => {
      const accent = card.kind === 'DEPARTMENT' ? '#2563eb' : GRADE_HEX[card.row?.grade ?? ''] ?? '#94a3b8';
      const holders = card.row ? people.get(card.key) ?? [] : [];
      const style = `left:${card.x}px;top:${card.y}px;width:${card.w}px;height:${card.h}px;border-left-color:${accent}`;
      if (card.kind === 'DEPARTMENT') {
        return `<div class="card dept" style="${style}"><span class="nm">${escapeHtml(card.dept?.name ?? '')}</span><span class="code">${escapeHtml(card.dept?.code ?? '')}</span></div>`;
      }
      const title = card.row?.name ?? '';
      const code = card.row?.code ?? '';
      const holder =
        holders.length === 0
          ? '<div class="who">vacant</div>'
          : holders
              .slice(0, 2)
              .map((name) => `<div class="who">${escapeHtml(name)}</div>`)
              .join('') + (holders.length > 2 ? `<div class="who">+${holders.length - 2} more</div>` : '');
      return `<div class="card${card.kind === 'DESIGNATION' && holders.length === 0 ? ' vacant' : ''}" style="${style}"><div class="nm">${escapeHtml(title)}</div>${holder}<div class="meta"><span class="code">${escapeHtml(code)}</span></div></div>`;
    })
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Organizational Chart — Departments</title>
<style>
  @page { size: A3 landscape; margin: 8mm; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #0f172a; background: #fff; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  p.sub { font-size: 9px; color: #64748b; margin: 0 0 10px; }
  .board { position: relative; width: ${layout.width}px; height: ${layout.height}px; }
  svg { position: absolute; left: 0; top: 0; }
  .card { position: absolute; box-sizing: border-box; border: 1px solid #cbd5e1; border-left: 4px solid #94a3b8; border-radius: 7px; background: #fff; padding: 5px 7px; font-size: 10px; overflow: hidden; }
  .card .nm { font-weight: 700; line-height: 1.2; }
  .card .meta { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 5px; font-size: 8px; color: #64748b; }
  .card .who { color: #3730a3; font-weight: 600; }
  .card .vac { color: #b45309; font-weight: 700; text-transform: uppercase; }
  .card.vacant { border-style: dashed; border-color: #fbbf24; }
  .card.dept { display: flex; align-items: center; justify-content: space-between; background: #eff6ff; border-color: #bfdbfe; font-size: 10px; }
  .card.dept .code { font-size: 8px; color: #2563eb; font-weight: 700; }
</style></head>
<body>
  <h1>Proposed Organizational Structure — Departments</h1>
  <p class="sub">${placed.filter((card) => card.kind === 'DESIGNATION').length} posts · ${placed.filter((card) => card.kind === 'DEPARTMENT').length} departments · derived from the HR designation catalogue and the Employee Directory (branch-scoped). Save this print dialog as PDF; choose A3 landscape for one page.</p>
  <div class="board">
    <svg width="${layout.width}" height="${layout.height}">${paths}</svg>
    ${cards}
  </div>
</body></html>`;
}

type BoardOffsets = Record<string, { x: number; y: number }>;
type BoardViewport = { zoom: number; x: number; y: number };
type BoardLinkRoutes = Record<string, number>;

interface OrgChartBoardProps {
  catalogue: HrOrgCatalogue;
  employeesByDesignation: Map<string, HrOrgChartEmployee[]>;
  needle: string;
  onClearSearch: () => void;
  /** Preference key for this board's saved arrangement (`departments`, `branch:BR-01`). */
  layoutKey?: string;
  heading?: string;
  /** Marks a holder as head-office core or branch team, for the avatar badge. */
  teamOf?: (employee: HrOrgChartEmployee) => 'CORE' | 'BRANCH';
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

/** Employee avatar: the uploaded profile photo, or initials when none exists. */
const Avatar: React.FC<{ employee: HrOrgChartEmployee; size?: number }> = ({ employee, size = 16 }) => {
  if (employee.profilePhoto) {
    return (
      <img
        src={employee.profilePhoto}
        alt={employee.name}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-indigo-100 font-bold text-indigo-700"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials(employee.name)}
    </span>
  );
};

const GRADE_HEX: Record<string, string> = {
  G10: '#1e293b', G9: '#334155', G8: '#1d4ed8', G7: '#2563eb', G6: '#4f46e5',
  G5: '#0d9488', G4: '#d97706', G3: '#ea580c', G2: '#64748b', G1: '#78716c',
};

/** The bend of an adjustable link, where the drag handle is drawn. */
export const linkHandle = (
  from: BoardCard,
  to: BoardCard,
  kind: BoardLink['kind'],
  lane = 0
): { x: number; y: number } | null => {
  if (kind === 'ELBOW') {
    return { x: from.x - 10 - lane, y: (from.y + from.h / 2 + to.y + to.h / 2) / 2 };
  }
  if (kind === 'HORIZONTAL') {
    const goingRight = to.x > from.x;
    const sx = goingRight ? from.x + from.w : from.x;
    const ex = goingRight ? to.x : to.x + to.w;
    return { x: (sx + ex) / 2 + lane, y: (from.y + from.h / 2 + to.y + to.h / 2) / 2 };
  }
  if (kind === 'RAIL') {
    const bottom = from.y + from.h;
    const gap = to.y > bottom ? Math.max(8, (to.y - bottom) / 2) : 8;
    return { x: (from.x + from.w / 2 + to.x + to.w / 2) / 2, y: bottom + gap + lane };
  }
  return null;
};

export const linkPath = (
  from: BoardCard,
  to: BoardCard,
  kind: BoardLink['kind'],
  lane = 0
): string => {
  if (kind === 'ELBOW') {
    // Attach to the left edge of both cards and route through the gutter to the
    // left of the children, so a line never crosses a card face. `lane` moves
    // the vertical segment further into (or out of) the gutter.
    const sx = from.x - 10 - lane;
    const sy = from.y + from.h / 2;
    const ty = to.y + to.h / 2;
    return `M ${from.x} ${sy} H ${sx} V ${ty} H ${to.x}`;
  }
  if (kind === 'HORIZONTAL') {
    const goingRight = to.x > from.x;
    const sx = goingRight ? from.x + from.w : from.x;
    const ex = goingRight ? to.x : to.x + to.w;
    const sy = from.y + from.h / 2;
    const ey = to.y + to.h / 2;
    const midX = (sx + ex) / 2 + lane;
    return `M ${sx} ${sy} H ${midX} V ${ey} H ${ex}`;
  }
  if (kind === 'RAIL') {
    // The horizontal rail must sit in the gap below the parent card, never
    // above its bottom edge (which would draw the line back across the card).
    // `lane` slides it up/down inside that gap.
    const bottom = from.y + from.h;
    const gap = to.y > bottom ? Math.max(8, (to.y - bottom) / 2) : 8;
    const railY = bottom + gap + lane;
    const sx = from.x + from.w / 2;
    const ex = to.x + to.w / 2;
    return `M ${sx} ${bottom} V ${railY} H ${ex} V ${to.y}`;
  }
  const sx = from.x + from.w / 2;
  const sy = from.y + from.h;
  const ex = to.x + to.w / 2;
  const ey = to.y;
  if (Math.abs(sx - ex) < 2) return `M ${sx} ${sy} V ${ey}`;
  const midY = sy + Math.max(14, (ey - sy) / 2);
  return `M ${sx} ${sy} V ${midY} H ${ex} V ${ey}`;
};

export const OrgChartBoard: React.FC<OrgChartBoardProps> = ({
  catalogue,
  employeesByDesignation,
  needle,
  onClearSearch,
  layoutKey = 'departments',
  heading = 'Department board',
  teamOf,
}) => {
  const layout = useMemo(() => buildBoardLayout(catalogue), [catalogue]);
  const byKey = useMemo(() => new Map(layout.cards.map((card) => [card.key, card])), [layout]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [tool, setTool] = useState<'POINTER' | 'HAND'>('POINTER');
  const [fullscreen, setFullscreen] = useState(false);
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [zoom, setZoom] = useState(0.7);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // The board fills whatever height is left in the window, so the hierarchy is
  // readable without scrolling the page first.
  const [boardHeight, setBoardHeight] = useState(560);
  // Manual card positions, so a crowded column can be spread out and its
  // connectors followed. Reset layout snaps everything back to the derived
  // positions.
  const [offsets, setOffsets] = useState<BoardOffsets>({});
  const layoutMap = useRef<Record<string, BoardOffsets>>({});
  const layoutLoaded = useRef(false);
  const saveTimer = useRef<number | null>(null);
  // Zoom/pan per board, so a view switch or fullscreen toggle returns to the
  // framing the user left instead of snapping back to a fresh Fit.
  const viewportMap = useRef<Record<string, BoardViewport>>({});
  const [viewportReady, setViewportReady] = useState(false);
  const savedFraming = useRef(false);
  const viewSaveTimer = useRef<number | null>(null);
  // Connector lanes, keyed by the link's stable `from->to` pair.
  const [linkRoutes, setLinkRoutes] = useState<BoardLinkRoutes>({});
  const linkRoutesMap = useRef<Record<string, BoardLinkRoutes>>({});
  const linkRoutesLoaded = useRef(false);
  const linkSaveTimer = useRef<number | null>(null);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const linkDrag = useRef<{
    key: string;
    kind: BoardLink['kind'];
    from: BoardCard;
    to: BoardCard;
  } | null>(null);
  /** Framing to restore when the fullscreen overlay closes. */
  const preFullscreenFraming = useRef<BoardViewport | null>(null);

  const toggleFullscreen = () => {
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    preFullscreenFraming.current = { zoom, x: pan.x, y: pan.y };
    setFullscreen(true);
  };
  const [arrangementSaved, setArrangementSaved] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const cardDrag = useRef<{
    keys: string[];
    primary: string;
    startX: number;
    startY: number;
    origins: Record<string, { x: number; y: number }>;
    moved: boolean;
  } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; zoom: number; mid: { x: number; y: number }; panX: number; panY: number } | null>(null);

  const placedCards = useMemo(
    () =>
      layout.cards.map((card) => {
        const offset = offsets[card.key];
        return offset ? { ...card, x: card.x + offset.x, y: card.y + offset.y } : card;
      }),
    [layout, offsets]
  );
  const placedByKey = useMemo(
    () => new Map(placedCards.map((card) => [card.key, card])),
    [placedCards]
  );
  const arranged = Object.keys(offsets).length > 0;

  const holdersOf = (designationId: string) => employeesByDesignation.get(designationId) ?? [];

  const cardMatches = useCallback(
    (card: BoardCard): boolean => {
      if (!needle) return true;
if (card.kind === 'DEPARTMENT') {
        const dept = card.dept;
        if (!dept) return false;
        if ((dept.name + ' ' + (dept.code || '')).toLowerCase().includes(needle)) return true;
        return layout.cards.some(
          (candidate) =>
            candidate.kind === 'DESIGNATION' &&
            candidate.dept?.id === dept.id &&
            ((candidate.row &&
              (candidate.row.name + ' ' + (candidate.row.code || '') + ' ' + (candidate.row.grade || ''))
                .toLowerCase()
                .includes(needle)) ||
              (candidate.row
                ? holdersOf(candidate.row.id).some((employee) =>
                    (employee.name + ' ' + employee.employeeCode + ' ' + (employee.branchName || ''))
                      .toLowerCase()
                      .includes(needle)
                  )
                : false))
        );
      }
      const row = card.row;
      if (!row) return false;
      if (
        (row.name + ' ' + (row.code || '') + ' ' + (row.grade || '') + ' ' + (row.department || ''))
          .toLowerCase()
          .includes(needle)
      ) {
        return true;
      }
      return holdersOf(row.id).some((employee) =>
        (employee.name + ' ' + employee.employeeCode + ' ' + (employee.branchName || ''))
          .toLowerCase()
          .includes(needle)
      );
    },
    [needle, layout, employeesByDesignation]
  );

  const fit = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    // Fit BOTH axes: the whole derived hierarchy has to be visible, not just
    // its widest row, otherwise the bottom departments need a pan to reach.
    const scale = Math.min(
      1,
      Math.max(
        MIN_ZOOM,
        Math.min((element.clientWidth - 24) / layout.width, (element.clientHeight - 24) / layout.height)
      )
    );
    const offsetX = Math.max(0, (element.clientWidth - layout.width * scale) / 2);
    const offsetY = Math.max(0, (element.clientHeight - layout.height * scale) / 2);
    setZoom(scale);
    setPan({ x: offsetX, y: offsetY });
  }, [layout.width, layout.height]);

  /** Explicit Fit is a deliberate framing choice, so keep it across resizes. */
  const fitView = () => {
    fit();
    savedFraming.current = true;
  };

  // Measure the room left below the board header, and keep it correct when the
  // window is resized, the surrounding toolbar wraps, or fullscreen is toggled.
  const measure = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    // Fullscreen lets the flex layout fill the window; leaving the normal
    // height untouched keeps the framing identical when the overlay closes.
    if (fullscreen) return;
    const top = element.getBoundingClientRect().top;
    setBoardHeight(Math.max(200, Math.floor(window.innerHeight - top - BOTTOM_RESERVE)));
  }, [fullscreen]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  useEffect(() => {
    // Run directly (not via requestAnimationFrame): a background browser tab
    // throttles animation frames, which would leave the default 70% zoom and
    // clip the bottom departments. A restored framing always wins over this
    // automatic fit.
    if (savedFraming.current) return;
    fit();
  }, [fit, boardHeight]);

  // Fullscreen is an in-app overlay, so it covers the whole window without
  // needing the browser's fullscreen permission. Lock the page behind it.
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [fullscreen]);

  // Entering fullscreen fits the larger canvas; leaving it returns to the
  // framing the board had before, which is also what gets persisted.
  useEffect(() => {
    if (!fullscreen) {
      const previous = preFullscreenFraming.current;
      preFullscreenFraming.current = null;
      if (previous) {
        setZoom(previous.zoom);
        setPan({ x: previous.x, y: previous.y });
      }
      return;
    }
    const frame = window.setTimeout(fit, 0);
    return () => window.clearTimeout(frame);
  }, [fullscreen, fit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (fullscreen) {
        setFullscreen(false);
        return;
      }
      setSelectedKey(null);
      setSelectedKeys([]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  // The arrangement lives in the user's server-side preferences, so it follows
  // them to another machine instead of dying with this browser tab.
  useEffect(() => {
    let cancelled = false;
    layoutLoaded.current = false;
    api.getSettings().then((bundle) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(bundle.preferences?.orgChartLayout || '{}');
          layoutMap.current = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          layoutMap.current = {};
        }
        try {
          const parsedViewport = JSON.parse(bundle.preferences?.orgChartViewport || '{}');
          viewportMap.current =
            parsedViewport && typeof parsedViewport === 'object' ? parsedViewport : {};
        } catch {
          viewportMap.current = {};
        }
        try {
          const parsedRoutes = JSON.parse(bundle.preferences?.orgChartLinkRoutes || '{}');
          linkRoutesMap.current =
            parsedRoutes && typeof parsedRoutes === 'object' ? parsedRoutes : {};
        } catch {
          linkRoutesMap.current = {};
        }
        const savedRoutes = linkRoutesMap.current[layoutKey];
        setLinkRoutes(savedRoutes && typeof savedRoutes === 'object' ? savedRoutes : {});
        linkRoutesLoaded.current = true;

        const saved = viewportMap.current[layoutKey];
        if (
          saved &&
          Number.isFinite(saved.zoom) &&
          Number.isFinite(saved.x) &&
          Number.isFinite(saved.y)
        ) {
          setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, saved.zoom)));
          setPan({ x: saved.x, y: saved.y });
          savedFraming.current = true;
        }
        setOffsets(layoutMap.current[layoutKey] ?? {});
        layoutLoaded.current = true;
        setViewportReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          layoutLoaded.current = true;
          setViewportReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [layoutKey]);

  useEffect(() => {
    if (!layoutLoaded.current) return;
    layoutMap.current[layoutKey] = offsets;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api
        .savePreferences({ orgChartLayout: JSON.stringify(layoutMap.current) })
        .then(() => setArrangementSaved(true))
        .catch(() => setArrangementSaved(false));
    }, 700);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [offsets, layoutKey]);

  // Connector lanes follow the same pattern as the card arrangement: one
  // preference, one entry per board, saved after a short debounce.
  useEffect(() => {
    if (!linkRoutesLoaded.current) return;
    linkRoutesMap.current[layoutKey] = linkRoutes;
    if (linkSaveTimer.current) window.clearTimeout(linkSaveTimer.current);
    linkSaveTimer.current = window.setTimeout(() => {
      api
        .savePreferences({ orgChartLinkRoutes: JSON.stringify(linkRoutesMap.current) })
        .catch(() => {});
    }, 700);
    return () => {
      if (linkSaveTimer.current) window.clearTimeout(linkSaveTimer.current);
    };
  }, [linkRoutes, layoutKey]);

  // Persist the framing of this board only after its saved value has been
  // read, so the pre-restore default never overwrites what the user had.
  useEffect(() => {
    // The fullscreen canvas has a different fit; only the normal board framing
    // is persisted, and the pre-fullscreen one is restored on exit.
    if (!viewportReady || fullscreen) return;
    viewportMap.current[layoutKey] = { zoom, x: pan.x, y: pan.y };
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = window.setTimeout(() => {
      api
        .savePreferences({ orgChartViewport: JSON.stringify(viewportMap.current) })
        .catch(() => {});
    }, 700);
    return () => {
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    };
  }, [zoom, pan, layoutKey, viewportReady, fullscreen]);

  // Flush a pending debounce when the board unmounts (switching view), so the
  // last drag is not lost.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        api.savePreferences({ orgChartLayout: JSON.stringify(layoutMap.current) }).catch(() => {});
      }
      if (viewSaveTimer.current) {
        window.clearTimeout(viewSaveTimer.current);
        api.savePreferences({ orgChartViewport: JSON.stringify(viewportMap.current) }).catch(() => {});
      }
      if (linkSaveTimer.current) {
        window.clearTimeout(linkSaveTimer.current);
        api.savePreferences({ orgChartLinkRoutes: JSON.stringify(linkRoutesMap.current) }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      savedFraming.current = true;
      setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * (event.deltaY < 0 ? 1.12 : 0.9))));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const selected = selectedKey ? byKey.get(selectedKey) : null;
  const selectedDept = selected?.dept ?? null;
  const selectedHolders = selected?.row ? holdersOf(selected.row.id) : [];
  const deptPosts = selectedDept
    ? layout.cards.filter((card) => card.kind === 'DESIGNATION' && card.dept?.id === selectedDept.id)
    : [];
  const deptPeople = deptPosts.flatMap((card) => (card.row ? holdersOf(card.row.id) : []));
  const filterActive = Boolean(needle) || Boolean(selectedKey) || selectedKeys.length > 0;

  const clearAll = () => {
    onClearSearch();
    setSelectedKey(null);
    setSelectedKeys([]);
    setOffsets({});
    setLinkRoutes({});
    fitView();
  };

  const resetLayout = () => {
    setOffsets({});
    setLinkRoutes({});
    setSelectedKey(null);
    setSelectedKeys([]);
    fitView();
  };

  const exportPdf = () => {
    const people = new Map<string, string[]>();
    placedCards.forEach((card) => {
      if (card.row) people.set(card.key, holdersOf(card.row.id).map((employee) => employee.name));
    });
    const html = buildBoardPrintHtml(layout, placedCards, people, linkRoutes);
    const printWindow = window.open('', '_blank', 'width=1280,height=900');
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        /* the user can still print from the opened tab */
      }
    }, 350);
  };

  const changeZoom = (factor: number) => {
    savedFraming.current = true;
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor)));
  };

  /** Keep a dragged lane inside the space where its bend makes sense. */
  const clampLinkLane = (drag: NonNullable<typeof linkDrag.current>, lane: number): number => {
    if (drag.kind === 'RAIL') {
      const bottom = drag.from.y + drag.from.h;
      const gap = drag.to.y > bottom ? Math.max(8, (drag.to.y - bottom) / 2) : 8;
      const min = 6 - gap;
      const max = Math.max(min, drag.to.y - bottom - 6 - gap);
      return Math.max(min, Math.min(max, lane));
    }
    return Math.max(-600, Math.min(600, lane));
  };

  const dragLinkTo = (event: React.PointerEvent) => {
    const drag = linkDrag.current;
    const element = viewportRef.current;
    if (!drag || !element) return;
    const rect = element.getBoundingClientRect();
    const boardX = (event.clientX - rect.left - pan.x) / zoom;
    const boardY = (event.clientY - rect.top - pan.y) / zoom;
    let lane = 0;
    if (drag.kind === 'ELBOW') {
      lane = drag.from.x - 10 - boardX;
    } else if (drag.kind === 'HORIZONTAL') {
      const goingRight = drag.to.x > drag.from.x;
      const sx = goingRight ? drag.from.x + drag.from.w : drag.from.x;
      const ex = goingRight ? drag.to.x : drag.to.x + drag.to.w;
      lane = boardX - (sx + ex) / 2;
    } else if (drag.kind === 'RAIL') {
      const bottom = drag.from.y + drag.from.h;
      const gap = drag.to.y > bottom ? Math.max(8, (drag.to.y - bottom) / 2) : 8;
      lane = boardY - (bottom + gap);
    }
    const next = Math.round(clampLinkLane(drag, lane));
    setLinkRoutes((previous) => ({ ...previous, [drag.key]: next }));
  };

  const startLinkDrag = (
    event: React.PointerEvent<SVGGElement>,
    link: BoardLink,
    from: BoardCard,
    to: BoardCard
  ) => {
    if (event.button !== 0 || tool === 'HAND') return;
    event.stopPropagation();
    event.preventDefault();
    const key = `${link.from}->${link.to}`;
    linkDrag.current = { key, kind: link.kind, from, to };
    setHoveredLink(key);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the board still receives moves while the pointer stays over the line */
    }
  };

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[100] flex h-[100dvh] w-screen flex-col rounded-none border-0 bg-white dark:bg-[#12161f]'
          : 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#12161f]'
      }
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen || undefined}
      aria-label={fullscreen ? 'Organizational chart, full window' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {heading}
        </span>
        {arranged && arrangementSaved ? (
          <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
            arrangement saved
          </span>
        ) : null}
        <span className="hidden text-[10px] text-slate-400 sm:inline">
          {tool === 'HAND'
            ? 'hand: drag anywhere (cards included) to pan · wheel needs ctrl'
            : 'pointer: drag cards or a connector bend, marquee empty space, shift-click to add · Esc clears selection'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {(
              [
                ['POINTER', 'Pointer', MousePointer2, 'Select and drag cards (marquee for several)'],
                ['HAND', 'Hand', Hand, 'Drag anywhere to pan the board'],
              ] as const
            ).map(([id, label, Icon, hint]) => (
              <button
                key={id}
                type="button"
                title={hint}
                aria-pressed={tool === id}
                onClick={() => setTool(id)}
                className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold ${
                  tool === id
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
          {selectedKeys.length > 1 ? (
            <span className="rounded-full bg-indigo-50 px-2 py-1 text-[10px] font-bold text-indigo-700">
              {selectedKeys.length} selected
            </span>
          ) : null}
          <button
            type="button"
            onClick={fitView}
            className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Maximize2 className="h-3 w-3" /> Fit
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Exit full window (Esc)' : 'Use the whole window for this board'}
            className={
              fullscreen
                ? 'flex cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-700'
                : 'flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
            }
          >
            {fullscreen ? <Minimize className="h-3 w-3" /> : <Maximize className="h-3 w-3" />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
          <button
            type="button"
            onClick={() => changeZoom(0.9)}
            aria-label="Zoom out"
            className="cursor-pointer rounded-lg border border-slate-300 p-1 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="min-w-[34px] text-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => changeZoom(1.1)}
            aria-label="Zoom in"
            className="cursor-pointer rounded-lg border border-slate-300 p-1 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={resetLayout}
            disabled={!arranged}
            title="Snap every card back to its derived position"
            className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <RotateCcw className="h-3 w-3" /> Reset layout
          </button>
          <button
            type="button"
            onClick={exportPdf}
            title="Open an A3 landscape print view; choose Save as PDF"
            className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <FileDown className="h-3 w-3" /> Export PDF
          </button>
          {filterActive ? (
            <button
              type="button"
              onClick={clearAll}
              className="flex cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-700"
            >
              <X className="h-3 w-3" /> Clear filter
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={viewportRef}
        onPointerDownCapture={(event) => {
          // Capture phase so a second finger that lands on a card still turns
          // the gesture into a pinch.
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 2) {
            drag.current = null;
            cardDrag.current = null;
            setMarquee(null);
            const [a, b] = [...pointers.current.values()];
            pinch.current = {
              dist: Math.hypot(a.x - b.x, a.y - b.y),
              zoom,
              mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              panX: pan.x,
              panY: pan.y,
            };
          }
        }}
        onPointerDown={(event) => {
          if (pointers.current.size !== 1) return;
          const onCard = Boolean((event.target as HTMLElement).closest('[data-card]'));
          const wantsPan = tool === 'HAND' || event.button === 1 || event.ctrlKey || event.metaKey;
          if (wantsPan) {
            savedFraming.current = true;
            drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
            try {
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            } catch {
              /* pan still works while the pointer stays over the board */
            }
            return;
          }
          if (onCard) return;
          // Pointer tool on empty canvas starts a selection marquee.
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          setMarquee({ x0: x, y0: y, x1: x, y1: y });
          if (!event.shiftKey) {
            setSelectedKeys([]);
            setSelectedKey(null);
          }
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointers.current.has(event.pointerId)) {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          }
          if (linkDrag.current) {
            dragLinkTo(event);
            return;
          }
          if (pointers.current.size >= 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const scale = pinch.current.dist > 0 ? dist / pinch.current.dist : 1;
            setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.current.zoom * scale)));
            setPan({
              x: pinch.current.panX + (mid.x - pinch.current.mid.x),
              y: pinch.current.panY + (mid.y - pinch.current.mid.y),
            });
            return;
          }
          if (marquee) {
            const rect = viewportRef.current?.getBoundingClientRect();
            if (rect) {
              setMarquee((current) =>
                current
                  ? { ...current, x1: event.clientX - rect.left, y1: event.clientY - rect.top }
                  : current
              );
            }
            return;
          }
          const current = drag.current;
          if (!current) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
          setPan({ x: current.panX + dx, y: current.panY + dy });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (linkDrag.current) {
            linkDrag.current = null;
            return;
          }
          if (marquee) {
            const left = (Math.min(marquee.x0, marquee.x1) - pan.x) / zoom;
            const right = (Math.max(marquee.x0, marquee.x1) - pan.x) / zoom;
            const top = (Math.min(marquee.y0, marquee.y1) - pan.y) / zoom;
            const bottom = (Math.max(marquee.y0, marquee.y1) - pan.y) / zoom;
            const hits = placedCards
              .filter(
                (card) =>
                  card.x < right && card.x + card.w > left && card.y < bottom && card.y + card.h > top
              )
              .map((card) => card.key);
            setSelectedKeys(hits);
            setSelectedKey(hits.length === 1 ? hits[0] : null);
            setMarquee(null);
            return;
          }
          const current = drag.current;
          drag.current = null;
          if (current && !current.moved) setSelectedKey(null);
        }}
        onPointerCancel={() => {
          pointers.current.clear();
          pinch.current = null;
          drag.current = null;
          cardDrag.current = null;
          linkDrag.current = null;
        }}
        className={`relative select-none touch-none overflow-hidden ${
          fullscreen ? 'min-h-0 flex-1' : 'min-h-[200px]'
        } ${tool === 'HAND' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
        style={{
          height: fullscreen ? undefined : boardHeight,
          backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          backgroundColor: '#f8fafc',
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >

          {placedCards.map((card) => {
            const isSelected = selectedKeys.includes(card.key) || selectedKey === card.key;
            const dimmed = needle.length > 0 && !cardMatches(card);
            const holders = card.row ? holdersOf(card.row.id) : [];
            const isDept = card.kind === 'DEPARTMENT';
            const accent = isDept
              ? '#2563eb'
              : card.row?.grade
                ? GRADE_HEX[card.row.grade] ?? '#64748b'
                : '#94a3b8';
            return (
              <button
                key={card.key}
                data-card
                type="button"
                onPointerDown={(event) => {
                  if (tool === 'HAND') return; // let the board pan from anywhere
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  if (event.shiftKey || event.metaKey || event.ctrlKey) {
                    setSelectedKeys((previous) =>
                      previous.includes(card.key)
                        ? previous.filter((key) => key !== card.key)
                        : [...previous, card.key]
                    );
                    return;
                  }
                  // Dragging any card in the current selection moves the group.
                  const keys = selectedKeys.includes(card.key) ? selectedKeys : [card.key];
                  const origins: Record<string, { x: number; y: number }> = {};
                  keys.forEach((key) => {
                    origins[key] = offsets[key] ?? { x: 0, y: 0 };
                  });
                  cardDrag.current = {
                    keys,
                    primary: card.key,
                    startX: event.clientX,
                    startY: event.clientY,
                    origins,
                    moved: false,
                  };
                  if (!selectedKeys.includes(card.key)) setSelectedKeys([card.key]);
                  try {
                    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                  } catch {
                    /* browsers without pointer capture still receive moves while over the card */
                  }
                }}
                onPointerMove={(event) => {
                  const current = cardDrag.current;
                  if (!current) return;
                  const dx = (event.clientX - current.startX) / zoom;
                  const dy = (event.clientY - current.startY) / zoom;
                  if (Math.abs(dx) + Math.abs(dy) > 2) current.moved = true;
                  if (!current.moved) return;
                  setOffsets((previous) => {
                    const next = { ...previous };
                    current.keys.forEach((key) => {
                      const origin = current.origins[key] ?? { x: 0, y: 0 };
                      next[key] = { x: origin.x + dx, y: origin.y + dy };
                    });
                    return next;
                  });
                }}
                onPointerUp={() => {
                  const current = cardDrag.current;
                  cardDrag.current = null;
                  if (current && !current.moved) {
                    setSelectedKey(current.primary);
                    setSelectedKeys([current.primary]);
                  }
                }}
                title={isDept ? `${card.dept?.name} — click for department` : card.row?.name}
                className={`absolute z-10 cursor-grab touch-none overflow-hidden rounded-lg border bg-white text-left shadow-sm transition hover:shadow-md active:cursor-grabbing ${
                  isSelected ? 'ring-2 ring-indigo-500' : ''
                } ${dimmed ? 'opacity-25' : 'opacity-100'} ${
                  card.kind === 'DESIGNATION' && holders.length === 0
                    ? 'border-dashed border-amber-400'
                    : 'border-slate-300 dark:border-slate-700'
                }`}
                style={{
                  left: card.x,
                  top: card.y,
                  width: card.w,
                  height: card.h,
                  borderLeft: `4px solid ${accent}`,
                  pointerEvents: tool === 'HAND' ? 'none' : undefined,
                }}
              >
                {isDept ? (
                  <div className="flex h-full items-center justify-between gap-1 bg-blue-50 px-2 dark:bg-blue-950/30">
                    <span className="truncate text-[10px] font-bold text-slate-800 dark:text-slate-100">
                      {card.dept?.name}
                    </span>
                    <span className="shrink-0 text-[8px] font-bold uppercase text-blue-600 dark:text-blue-300">
                      {card.dept?.code}
                    </span>
                  </div>
                ) : (
                  <div className="flex h-full flex-col justify-between px-2 py-1">
                    <div className="flex items-start justify-between gap-1">
                      <span className="line-clamp-2 text-[10px] font-bold leading-tight text-slate-800 dark:text-slate-100">
                        {card.row?.name}
                      </span>
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[8px] font-black text-white"
                        style={{ backgroundColor: GRADE_HEX[card.row?.grade ?? ''] ?? '#94a3b8' }}
                      >
                        {card.row?.grade || '—'}
                      </span>
                    </div>

                    <div className="mt-0.5 space-y-0.5">
                      {holders.length === 0 ? (
                        <span className="inline-block rounded-full bg-amber-50 px-1.5 text-[8px] font-bold uppercase text-amber-700">
                          vacant
                        </span>
                      ) : (
                        <>
                          {holders.slice(0, 2).map((employee) => (
                            <div key={employee.id} className="flex items-center gap-1" title={`${employee.name} · ${employee.employeeCode}`}>
                              <Avatar employee={employee} size={14} />
                              <span className="truncate text-[10px] font-semibold text-slate-700 dark:text-slate-200">
                                {employee.name}
                              </span>
                              {teamOf ? (
                                <span
                                  className={`ml-auto shrink-0 rounded px-0.5 text-[7px] font-black uppercase ${
                                    teamOf(employee) === 'CORE'
                                      ? 'bg-indigo-100 text-indigo-700'
                                      : 'bg-emerald-100 text-emerald-700'
                                  }`}
                                  title={teamOf(employee) === 'CORE' ? 'Head office core team' : 'Branch team'}
                                >
                                  {teamOf(employee) === 'CORE' ? 'HO' : 'BR'}
                                </span>
                              ) : null}
                            </div>
                          ))}
                          {holders.length > 2 ? (
                            <span className="text-[8px] font-bold text-slate-500">+{holders.length - 2} more</span>
                          ) : null}
                        </>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-[8px] text-slate-400">{card.row?.code}</span>
                      <span className="text-[8px] text-slate-400">
                        {holders.length ? `${holders.length} in post` : 'no holder'}
                      </span>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
          <svg
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute inset-0 z-20 overflow-visible"
          >
            {layout.links.map((link, index) => {
              const from = placedByKey.get(link.from);
              const to = placedByKey.get(link.to);
              if (!from || !to) return null;
              const key = `${link.from}->${link.to}`;
              const lane = linkRoutes[key] ?? 0;
              const handle = linkHandle(from, to, link.kind, lane);
              const connected =
                Boolean(handle) &&
                (selectedKey === link.from ||
                  selectedKey === link.to ||
                  selectedKeys.includes(link.from) ||
                  selectedKeys.includes(link.to));
              const showHandle = tool === 'POINTER' && Boolean(handle) && (hoveredLink === key || connected);
              const path = linkPath(from, to, link.kind, lane);
              const cursor = link.kind === 'RAIL' ? 'ns-resize' : 'ew-resize';
              return (
                <g
                  key={`${key}-${index}`}
                  onPointerEnter={() => setHoveredLink(key)}
                  onPointerLeave={() =>
                    setHoveredLink((current) => (current === key ? null : current))
                  }
                  onPointerDown={(event) => startLinkDrag(event, link, from, to)}
                >
                  <path
                    d={path}
                    fill="none"
                    stroke={link.dotted ? '#64748b' : '#2563eb'}
                    strokeWidth={1.8}
                    strokeDasharray={link.dotted ? '4 3' : undefined}
                  />
                  {tool === 'POINTER' && handle ? (
                    <path
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'stroke', cursor }}
                    />
                  ) : null}
                  {showHandle && handle ? (
                    <circle
                      cx={handle.x}
                      cy={handle.y}
                      r={5}
                      fill="#fff"
                      stroke="#4f46e5"
                      strokeWidth={2}
                      style={{ pointerEvents: 'all', cursor }}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>

        {marquee ? (
          <div
            className="pointer-events-none absolute z-30 rounded border border-indigo-500 bg-indigo-500/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        ) : null}

        {selected ? (
          <div className="absolute bottom-2 right-2 top-2 z-20 w-[310px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-2xl dark:border-slate-700 dark:bg-[#0f131b]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wide text-indigo-500">
                  {selected.kind === 'DEPARTMENT' ? 'Department' : 'Designation'}
                </p>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {selected.kind === 'DEPARTMENT' ? selected.dept?.name : selected.row?.name}
                </h3>
                <p className="font-mono text-[10px] text-slate-400">
                  {selected.kind === 'DEPARTMENT' ? selected.dept?.code : selected.row?.code}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedKey(null)}
                aria-label="Close details"
                className="cursor-pointer rounded-lg border border-slate-300 p-1 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {selected.kind === 'DESIGNATION' && selected.row ? (
              <div className="mt-2 space-y-2 text-[10px]">
                <div className="flex flex-wrap gap-1">
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-black text-white"
                    style={{ backgroundColor: GRADE_HEX[selected.row.grade ?? ''] ?? '#64748b' }}
                  >
                    {selected.row.grade || 'Ungraded'}
                  </span>
                  {selected.row.careerBand ? (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {selected.row.careerBand}
                    </span>
                  ) : null}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {selectedHolders.length
                      ? `${selectedHolders.length} holder${selectedHolders.length === 1 ? '' : 's'}`
                      : 'Vacant'}
                  </span>
                </div>
                <dl className="space-y-1">
                  {[
                    ['Reports to', selected.row.reportsTo || selected.row.reportsToLabel || 'Board of Directors'],
                    ['Dotted line', selected.row.dottedLineTo || '—'],
                    ['Branch scope', selected.row.branchScope || '—'],
                    [
                      'Salary band',
                      selected.row.bandMin != null && selected.row.bandMax != null
                        ? `NPR ${selected.row.bandMin.toLocaleString('en-IN')}–${selected.row.bandMax.toLocaleString('en-IN')}`
                        : '—',
                    ],
                    ['System role', selected.row.systemRole || '—'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
                      <dd className="text-right font-semibold text-slate-700 dark:text-slate-200">{value}</dd>
                    </div>
                  ))}
                </dl>

                <div>
                  <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <Users className="h-3 w-3" /> Personnel
                  </p>
                  {selectedHolders.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                      No active employee holds this post in your branch scope.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {selectedHolders.map((employee) => (
                        <li
                          key={employee.id}
                          className="flex items-start gap-1.5 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700"
                        >
                          <Avatar employee={employee} size={22} />
                          <div className="min-w-0">
                            <p className="truncate text-[10px] font-bold text-slate-800 dark:text-slate-100">
                              {employee.name}
                            </p>
                            <p className="text-[10px] text-slate-500 dark:text-slate-400">
                              {employee.employeeCode} · {employee.branchName || 'No branch'}
                              {employee.workStation ? ` · ${employee.workStation}` : ''}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {selectedDept ? (
                  <div className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                    <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      <Building2 className="h-3 w-3" /> Department
                    </p>
                    <p className="mt-0.5 text-[10px] font-bold text-slate-800 dark:text-slate-100">
                      {selectedDept.name}
                    </p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">
                      Head: {selectedDept.head || 'not set'} · {deptPosts.length} posts · {deptPeople.length} people
                    </p>
                    {selectedDept.mandate ? (
                      <p className="mt-1 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                        {selectedDept.mandate}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {selected.row.responsibilities ? (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Job description
                    </p>
                    <p className="mt-0.5 text-[10px] leading-snug text-slate-600 dark:text-slate-300">
                      {selected.row.responsibilities}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selected.kind === 'DEPARTMENT' && selected.dept ? (
              <div className="mt-2 space-y-2 text-[10px]">
                <dl className="space-y-1">
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">Head</dt>
                    <dd className="font-semibold text-slate-700 dark:text-slate-200">
                      {selected.dept.head || 'not set'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">Posts</dt>
                    <dd className="font-semibold text-slate-700 dark:text-slate-200">{deptPosts.length}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">People in scope</dt>
                    <dd className="font-semibold text-slate-700 dark:text-slate-200">{deptPeople.length}</dd>
                  </div>
                </dl>
                {selected.dept.mandate ? (
                  <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-300">
                    {selected.dept.mandate}
                  </p>
                ) : null}
                <div>
                  <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <Users className="h-3 w-3" /> Personnel
                  </p>
                  {deptPeople.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-300 p-2 text-[10px] text-slate-500">
                      Nobody in this department is in your branch scope.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {deptPeople.map((employee) => (
                        <li
                          key={employee.id}
                          className="flex items-start gap-1.5 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700"
                        >
                          <Avatar employee={employee} size={22} />
                          <div className="min-w-0">
                            <p className="truncate text-[10px] font-bold text-slate-800 dark:text-slate-100">
                              {employee.name}
                            </p>
                            <p className="text-[10px] text-slate-500 dark:text-slate-400">
                              {employee.designation || employee.catalogueDesignation || '—'} ·{' '}
                              {employee.branchName || 'No branch'}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}

            {filterActive ? (
              <button
                type="button"
                onClick={clearAll}
                className="mt-3 w-full cursor-pointer rounded-lg bg-indigo-600 px-2 py-1.5 text-[10px] font-bold text-white hover:bg-indigo-700"
              >
                Clear filter and show the whole chart
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default OrgChartBoard;
