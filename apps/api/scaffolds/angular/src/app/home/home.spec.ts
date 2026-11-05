import { type ComponentFixture, TestBed } from '@angular/core/testing';
import about from '../../about.json';
import { Home } from './home';

describe('Home', () => {
  let fixture: ComponentFixture<Home>;
  const page = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Home);
    await fixture.whenStable();
  });

  it('shows the name of the app', () => {
    expect(page().querySelector('h1')?.textContent).toBe(about.name);
  });

  it('counts clicks', async () => {
    const button = page().querySelector('button')!;
    expect(button.textContent).toContain('Clicked 0 times');

    button.click();
    await fixture.whenStable();

    expect(button.textContent).toContain('Clicked 1 time');
  });
});
