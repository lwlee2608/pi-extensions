import {
  type Component, type Focusable, fuzzyFilter, Input, type KeybindingsManager,
  SelectList, type SelectListTheme, truncateToWidth,
} from "@earendil-works/pi-tui";
import { type Favorite, modelKey } from "./store.ts";

interface Options {
  models: (Favorite & { name: string })[];
  favorites: Favorite[];
  keybindings: KeybindingsManager;
  theme: SelectListTheme;
  toggle: (model: Favorite) => Promise<boolean>;
  render: () => void;
  done: () => void | Promise<void>;
}

export class FavoritesManager implements Component, Focusable {
  private readonly options: Options;
  private readonly input = new Input({ placeholder: "Search models..." });
  private readonly favorites: Set<string>;
  private list!: SelectList;
  private busy = false;
  private status = "Changes save immediately. The active model stays unchanged.";

  constructor(options: Options) {
    this.options = options;
    this.favorites = new Set(options.favorites.map(modelKey));
    this.rebuild();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private rebuild(selected?: string): void {
    const models = fuzzyFilter(this.options.models, this.input.getValue(), (model) => `${modelKey(model)} ${model.name}`);
    const items = models.map((model) => ({
      value: modelKey(model),
      label: `${this.favorites.has(modelKey(model)) ? "★" : "☆"} ${modelKey(model)}`,
      description: model.name,
    }));
    this.list = new SelectList(items, 10, this.options.theme);
    if (selected) this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
  }

  async handleInput(data: string): Promise<void> {
    const kb = this.options.keybindings;
    if (this.busy) return;
    if (kb.matches(data, "tui.select.cancel")) {
      await this.options.done();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.list.getSelectedItem()?.value;
      const model = this.options.models.find((item) => modelKey(item) === selected);
      if (!model) return;
      this.busy = true;
      this.status = "Saving...";
      this.options.render();
      try {
        const added = await this.options.toggle(model);
        if (added) this.favorites.add(modelKey(model));
        else this.favorites.delete(modelKey(model));
        this.status = `${added ? "Bookmarked" : "Removed bookmark for"} ${modelKey(model)}`;
        this.rebuild(selected);
      } catch (error) {
        this.status = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        this.busy = false;
        this.options.render();
      }
      return;
    }
    if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const).some(
      (action) => kb.matches(data, action),
    )) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== previous) this.rebuild();
    }
    this.options.render();
  }

  render(width: number): string[] {
    const kb = this.options.keybindings;
    return [
      truncateToWidth("Add favorite models", width),
      ...this.input.render(width),
      ...this.list.render(width),
      truncateToWidth(this.status, width),
      truncateToWidth(`Type to search · ${kb.getKeys("tui.select.confirm").join("/")} toggle ★ · ${kb.getKeys("tui.select.cancel").join("/")} back`, width),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}
