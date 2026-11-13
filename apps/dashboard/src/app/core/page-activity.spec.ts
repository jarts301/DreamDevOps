import { HttpErrorResponse } from '@angular/common/http';
import { type NoticeBehavior, PageActivity } from './page-activity';

describe('PageActivity', () => {
  const failure = () => Promise.reject(new HttpErrorResponse({ status: 409, error: { detail: 'Already taken.' } }));
  const withNotice = (behavior: NoticeBehavior) => {
    const activity = new PageActivity(behavior);
    activity.notice.set('Saved.');
    return activity;
  };

  it('is busy while an action runs, and says whether it succeeded', async () => {
    const activity = new PageActivity('no-notice');
    let busy = false;

    const succeeded = await activity.run(async () => {
      busy = activity.working();
    });

    expect(busy).toBe(true);
    expect(succeeded).toBe(true);
    expect(activity.working()).toBe(false);
  });

  it('shows why an action failed, and clears that when the next one starts', async () => {
    const activity = new PageActivity('no-notice');

    expect(await activity.run(failure)).toBe(false);
    expect(activity.error()).toBe('Already taken.');
    expect(activity.working()).toBe(false);

    await activity.run(async () => {});
    expect(activity.error()).toBeNull();
  });

  it('clears the success message when the next action starts, if the page wants that', async () => {
    const activity = withNotice('clear-when-starting');

    await activity.run(async () => {});

    expect(activity.notice()).toBeNull();
  });

  it('keeps the success message unless the next action fails, if the page wants that', async () => {
    const activity = withNotice('clear-on-failure');

    await activity.run(async () => {});
    expect(activity.notice()).toBe('Saved.');

    await activity.run(failure);
    expect(activity.notice()).toBeNull();
  });

  it('shows what a change did, and reloads after it whether it worked or not', async () => {
    const activity = new PageActivity('clear-on-failure');
    const reload = vi.fn(async () => {});

    expect(await activity.change(async () => 'Saved.', reload)).toBe(true);
    expect(activity.notice()).toBe('Saved.');

    expect(await activity.change(failure, reload)).toBe(false);
    expect(activity.notice()).toBeNull();
    expect(activity.error()).toBe('Already taken.');
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps a change’s outcome on screen when reloading fails', async () => {
    const activity = new PageActivity('clear-on-failure');

    await activity.change(async () => 'Saved.', () => Promise.reject(new Error('offline')));

    expect(activity.notice()).toBe('Saved.');
    expect(activity.error()).toBeNull();
  });

  it('never touches the message on pages without one', async () => {
    const activity = withNotice('no-notice');

    await activity.run(failure);

    expect(activity.notice()).toBe('Saved.');
  });
});
