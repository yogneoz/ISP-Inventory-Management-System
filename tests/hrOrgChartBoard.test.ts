/**
 * Layout invariants for the Miro-style department board.
 *
 * PROVES:
 *   1. Every designation in the catalogue is placed on exactly one card, and
 *      cells never overlap (a card cannot hide another one).
 *   2. The leadership band and the department columns are connected the way the
 *      reference sheet reads: CEO → COO → each department head, then
 *      post-to-post inside the department. The Board's start card is not drawn.
 *   3. A department that holds only leadership posts (Executive Management)
 *      does not get an empty column.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardLayout, buildBoardPrintHtml, linkHandle, linkPath } from '../client/src/features/hr/OrgChartBoard';
import type { HrOrgCatalogue } from '../client/src/services/api';

const dept = (id: string, name: string, code: string, head: string) => ({
  id,
  name,
  code,
  headId: null,
  head,
  mandate: `${name} mandate.`,
});

const post = (id: string, name: string, code: string, departmentId: string, department: string, reportsToId: string | null, label: string | null = null) => ({
  id,
  name,
  code,
  departmentId,
  department,
  grade: 'G8',
  careerBand: 'Management',
  bandMin: 80000,
  bandMax: 120000,
  reportsToId,
  reportsTo: null,
  reportsToLabel: label,
  dottedLineTo: null,
  branchScope: 'All Branches (24)',
  systemRole: 'HEAD_OFFICE_ADMIN',
  responsibilities: `${name} duties.`,
  phase: 'Phase 1',
  roleStatus: 'Refactored',
  changeNote: null,
});

const catalogue: HrOrgCatalogue = {
  grades: [],
  clusters: [],
  branchPlan: [],
  departments: [
    dept('exe', 'Executive Management', 'DEPT-EXE', 'Chief Executive Officer'),
    dept('net', 'Core Network & IT', 'DEPT-NET', 'Head of Network & IT'),
    dept('hr', 'Human Resources', 'DEPT-HR', 'HR Manager'),
  ],
  designations: [
    post('ceo', 'Chief Executive Officer', 'DES-01', 'exe', 'Executive Management', null, 'Board of Directors'),
    post('coo', 'Chief Operations Officer', 'DES-02', 'exe', 'Executive Management', 'ceo'),
    post('legal', 'Legal & Strategic Consultant', 'DES-03', 'exe', 'Executive Management', null, 'Chief Executive Officer (Dotted)'),
    post('auditor', 'Internal Auditor & Compliance Officer', 'DES-41', 'exe', 'Executive Management', null, 'Board Audit Committee'),
    post('mis', 'MIS & Data Analyst', 'DES-08', 'exe', 'Executive Management', 'ceo'),
    post('headnet', 'Head of Network & IT', 'DES-04', 'net', 'Core Network & IT', 'coo'),
    post('sre', 'Senior Network Engineer', 'DES-47', 'net', 'Core Network & IT', 'headnet'),
    post('nadmin', 'Network Administrator', 'DES-05', 'net', 'Core Network & IT', 'sre'),
    post('hrmanager', 'HR Manager', 'DES-15', 'hr', 'Human Resources', 'coo'),
    post('hrassoc', 'HR Associate', 'DES-16', 'hr', 'Human Resources', 'hrmanager'),
  ],
};

describe('department board layout', () => {
  test('every post is placed once and no two cards overlap', () => {
    const layout = buildBoardLayout(catalogue);
    assert.equal(layout.width > 0 && layout.height > 0, true);
    assert.equal(layout.cards.filter((card) => card.kind === 'DESIGNATION').length, catalogue.designations.length);

    const seen = new Set<string>();
    for (const card of layout.cards) {
      if (card.kind !== 'DESIGNATION') continue;
      assert.ok(card.row, 'designation cards carry their row');
      assert.equal(seen.has(card.row!.id), false, `duplicate card for ${card.row!.id}`);
      seen.add(card.row!.id);
      assert.ok(card.x >= 0 && card.y >= 0, `${card.row!.code} sits outside the canvas`);
      assert.ok(card.x + card.w <= layout.width, `${card.row!.code} overflows horizontally`);
      assert.ok(card.y + card.h <= layout.height, `${card.row!.code} overflows vertically`);
    }

    for (let i = 0; i < layout.cards.length; i += 1) {
      for (let j = i + 1; j < layout.cards.length; j += 1) {
        const a = layout.cards[i];
        const b = layout.cards[j];
        if (a.kind !== 'DESIGNATION' || b.kind !== 'DESIGNATION') continue;
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(
          overlap,
          false,
          `${a.row?.code} overlaps ${b.row?.code} (${a.x},${a.y}) vs (${b.x},${b.y})`
        );
      }
    }
  });

  test('leadership, departments and posts are wired in the reference order', () => {
    const layout = buildBoardLayout(catalogue);
    const byKey = new Map(layout.cards.map((card) => [card.key, card]));
    const link = (from: string, to: string) =>
      layout.links.find((candidate) => candidate.from === from && candidate.to === to);

    // The governance start card was removed from the board, so the CEO is the
    // top card and no connector leaves a "board" placeholder.
    assert.equal(byKey.has('board'), false, 'the Board start card is not drawn');
    assert.equal(layout.links.some((candidate) => candidate.from === 'board'), false, 'nothing links from a removed board card');
    assert.equal(byKey.get('post:ceo')!.y, 0, 'the CEO is the top card');
    assert.ok(link('post:ceo', 'post:coo'), 'CEO → COO');
    for (const department of ['net', 'hr']) {
      assert.ok(link('post:coo', `dept:${department}`), `COO → ${department} column`);
      assert.equal(link('post:coo', `dept:${department}`)?.kind, 'RAIL');
    }
    assert.ok(link('dept:net', 'post:headnet'), 'department header → head post');
    assert.ok(link('post:headnet', 'post:sre'), 'head → senior');
    assert.ok(link('post:sre', 'post:nadmin'), 'senior → administrator');

    // Post-to-post lines attach to the LEFT edge of both cards and run in the
    // gutter, so a connector never crosses a card face.
    const headCard = byKey.get('post:headnet')!;
    const seniorCard = byKey.get('post:sre')!;
    const hierarchyPath = linkPath(headCard, seniorCard, 'ELBOW');
    assert.ok(
      hierarchyPath.startsWith(`M ${headCard.x} ${headCard.y + headCard.h / 2} H ${headCard.x - 10}`),
      `hierarchy line must leave the left edge: ${hierarchyPath}`
    );
    assert.ok(
      hierarchyPath.endsWith(`H ${seniorCard.x}`),
      'hierarchy line must enter the left edge of the child card'
    );

    const legalLink = layout.links.find((candidate) => candidate.to === 'post:legal');
    assert.equal(legalLink?.dotted, true, 'advisory lines are dotted');
    assert.equal(legalLink?.from, 'post:ceo');

    // A dragged connector lane moves only the bend: the attachments stay put,
    // and a RAIL slides its horizontal run through the gap below the parent.
    const cooCard = byKey.get('post:coo')!;
    const netDept = byKey.get('dept:net')!;
    const railBase = linkHandle(cooCard, netDept, 'RAIL', 0)!;
    const railMoved = linkHandle(cooCard, netDept, 'RAIL', 12)!;
    assert.equal(railMoved.y - railBase.y, 12, 'RAIL lane shifts the rail vertically');
    assert.ok(linkPath(cooCard, netDept, 'RAIL', 12).startsWith(`M ${cooCard.x + cooCard.w / 2} ${cooCard.y + cooCard.h}`), 'RAIL still leaves the parent’s bottom edge');
    const elbowBase = linkHandle(headCard, seniorCard, 'ELBOW', 0)!;
    const elbowMoved = linkHandle(headCard, seniorCard, 'ELBOW', 24)!;
    assert.equal(elbowBase.x - elbowMoved.x, 24, 'ELBOW lane moves the gutter segment left');

    const executiveColumn = layout.cards.find((card) => card.key === 'dept:exe');
    assert.equal(executiveColumn, undefined, 'no empty Executive Management column');
    assert.ok(byKey.has('post:mis'), 'MIS sits in the leadership band');
    assert.ok(byKey.get('post:mis')!.y < byKey.get('dept:net')!.y, 'leadership sits above the columns');
  });

  test('print export is a self-contained A3 document with every card and connector', () => {
    const layout = buildBoardLayout(catalogue);
    const people = new Map<string, string[]>([
      ['post:ceo', ['Sita Sharma']],
      ['post:sre', ['Bikash "BK" Thapa']],
    ]);
    const html = buildBoardPrintHtml(layout, layout.cards, people);
    assert.match(html, /@page \{ size: A3 landscape/);
    assert.match(html, /^<!doctype html>/);
    assert.equal((html.match(/<path /g) ?? []).length, layout.links.length, 'one path per connector');
    assert.equal(
      (html.match(/class="card/g) ?? []).length,
      layout.cards.length,
      'one element per card (plus the CSS class rules)'
    );
    assert.ok(html.includes('Sita Sharma'), 'holders are printed on the card');
    assert.ok(html.includes('Bikash &quot;BK&quot; Thapa'), 'names are HTML-escaped');
    assert.ok(html.includes('Chief Executive Officer'), 'the CEO starts the printed board');
    assert.equal(html.includes('Board of Directors'), false, 'the removed start card is not printed');
    assert.ok(!html.includes('<script'), 'no scripts in the print document');
  });
});
