import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import { type ApplicationType, groupByLayer } from './application-catalog.api';

/** Chooses an application type, grouped by layer. It shows whatever the catalog offers. */
@Component({
  selector: 'app-application-type-picker',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="type-picker">
      <legend>Application type</legend>
      @for (group of groups(); track group.layer.key) {
        <div class="type-group" role="group" [attr.aria-label]="group.layer.name">
          <p class="type-group-name">{{ group.layer.name }} <span class="muted">· {{ group.layer.description }}</span></p>
          <div class="type-options">
            @for (type of group.types; track type.key) {
              <label class="type-option">
                <!-- One name groups the choices, so arrow keys move between them and Tab stops once. -->
                <input
                  type="radio"
                  [name]="name()"
                  [attr.name]="name()"
                  [formControl]="control()"
                  [value]="type.key"
                  [attr.value]="type.key"
                  [attr.aria-describedby]="'type-' + type.key"
                />
                <span class="type-option-name">{{ type.name }}</span>
                <span class="type-option-detail" [id]="'type-' + type.key">
                  {{ type.language.runtime.name }} {{ type.language.runtime.version }} · {{ type.frameworks.join(', ') }}
                </span>
              </label>
            }
          </div>
        </div>
      }
    </fieldset>
  `,
})
export class ApplicationTypePicker {
  readonly types = input.required<readonly ApplicationType[]>();
  readonly control = input.required<FormControl<string>>();
  readonly name = input('application-type');
  protected readonly groups = computed(() => groupByLayer(this.types()));
}
