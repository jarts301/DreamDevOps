import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import { type ApplicationType, EMPTY_REPOSITORY } from './application-catalog.api';

/** Chooses what an application's repository starts with: one of its type's scaffolds, or nothing. */
@Component({
  selector: 'app-scaffold-picker',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (type(); as type) {
      <fieldset class="type-picker">
        <legend>Start from</legend>
        <div class="type-options">
          @for (scaffold of type.scaffolds; track scaffold.key) {
            <label class="type-option">
              <input
                type="radio"
                [name]="name()"
                [attr.name]="name()"
                [formControl]="control()"
                [value]="scaffold.key"
                [attr.value]="scaffold.key"
                [attr.aria-describedby]="'scaffold-' + scaffold.key"
              />
              <span class="type-option-name">{{ scaffold.name }}</span>
              <span class="type-option-detail" [id]="'scaffold-' + scaffold.key">{{ scaffold.description }}</span>
            </label>
          }
          <label class="type-option">
            <input
              type="radio"
              [name]="name()"
              [attr.name]="name()"
              [formControl]="control()"
              [value]="empty"
              [attr.value]="empty"
              aria-describedby="scaffold-empty"
            />
            <span class="type-option-name">Empty repository</span>
            <span class="type-option-detail" id="scaffold-empty">For code you already have, or to start from nothing.</span>
          </label>
        </div>
        @if (chosen(type); as scaffold) {
          <p class="hint">Includes: {{ scaffold.includes.join(' · ') }}</p>
        }
      </fieldset>
    }
  `,
})
export class ScaffoldPicker {
  readonly type = input.required<ApplicationType | null>();
  readonly control = input.required<FormControl<string>>();
  readonly name = input('application-scaffold');
  protected readonly empty = EMPTY_REPOSITORY;

  protected chosen(type: ApplicationType) {
    return type.scaffolds.find((scaffold) => scaffold.key === this.control().value) ?? null;
  }
}
