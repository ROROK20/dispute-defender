import { test, expect, type APIRequestContext } from '@playwright/test';

type DisputeDetail = {
  dispute: { id: string; source: string };
  run: { id: string; status: string; draft_json?: string | null } | null;
};

async function waitForRun(request: APIRequestContext, disputeId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/disputes/${encodeURIComponent(disputeId)}`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as DisputeDetail;
    if (body.run && ['draft_ready', 'failed'].includes(body.run.status)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`run for ${disputeId} did not finish within ${timeoutMs} ms`);
}

test.describe('demo loop (mock mode)', () => {
  test('health reports mock mode', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
    expect(body.mock.paypal).toBe(true);
  });

  test('inbox shows the mock banner and trigger button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/mock mode/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /trigger demo dispute/i })).toBeVisible();
  });

  test('trigger → agent draft → approve → submitted', async ({ page, request }) => {
    const pool = await request.get('/api/demo/pool');
    expect(pool.ok()).toBeTruthy();
    const { available } = await pool.json();

    const trigger = await request.post('/api/demo/trigger', { data: {} });
    if (available === 0) {
      expect(trigger.status()).toBe(409);
      expect((await trigger.json()).error.code).toBe('POOL_EMPTY');
      test.skip(true, 'dispute pool empty in this environment');
      return;
    }
    expect(trigger.status()).toBe(202);
    const { run_id, dispute_id, source } = await trigger.json();
    expect(source).toBe('demo_trigger');
    expect(run_id).toBeTruthy();

    const detail = await waitForRun(request, dispute_id);
    expect(detail.run!.status).toBe('draft_ready');

    await page.goto(`/disputes/${encodeURIComponent(dispute_id)}`);
    await expect(page.getByText(/demo trigger \(not a paypal webhook\)/i).first()).toBeVisible();
    await expect(page.getByText(/includes your approval time/i).first()).toBeVisible();

    const pdf = await request.get(`/api/disputes/${encodeURIComponent(dispute_id)}/pdf?run=${run_id}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(bytes.length).toBeLessThan(500 * 1024);

    const approve = await request.post(`/api/disputes/${encodeURIComponent(dispute_id)}/approve`, {
      data: { run_id },
    });
    const approveBody = await approve.json();
    if (approve.status() !== 200) {
      // A weak-evidence dispute may legitimately be recommended for concession; the run must still be intact.
      expect([409, 422]).toContain(approve.status());
      expect(approveBody.error.code).toBeTruthy();
      return;
    }
    expect(approveBody.status).toBe('submitted');
    expect(approveBody.paypal.status_code).toBeGreaterThanOrEqual(200);
    expect(approveBody.paypal.status_code).toBeLessThan(300);
    expect(approveBody.elapsed_ms).toBeGreaterThan(0);

    const calls = await request.get(`/api/paypal-calls?dispute_id=${encodeURIComponent(dispute_id)}`);
    const { calls: list } = await calls.json();
    expect(list.some((c: { path: string }) => c.path.includes('provide-evidence'))).toBe(true);
  });

  test('fixture disputes cannot be submitted', async ({ request }) => {
    const res = await request.get('/api/disputes');
    const { disputes } = await res.json();
    const fixture = (disputes as { id: string; source: string }[]).find((d) => d.source === 'fixture');
    test.skip(!fixture, 'no fixture history loaded');
    const approve = await request.post(`/api/disputes/${encodeURIComponent(fixture!.id)}/approve`, {
      data: { run_id: 'none' },
    });
    expect(approve.status()).toBe(422);
    expect((await approve.json()).error.code).toBe('FIXTURE_READ_ONLY');
  });
});