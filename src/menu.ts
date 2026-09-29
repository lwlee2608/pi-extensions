import {
  type Component, type Focusable, fuzzyFilter, Input, type KeybindingsManager, type KeyId,
  matchesKey, SelectList, type SelectListTheme, truncateToWidth,
} from "@earendil-works/pi-tui";
import { FavoritesManager } from "./manager.ts";
import { type Favorite, FavoritesStore, modelKey } from "./store.ts";

export const DEFAULT_APP_KEYBINDINGS = {
  "pi-model-plus.add": ["ctrl+n"],
  "pi-model-plus.remove": ["ctrl+r"],
} satisfies Record<string, KeyId[]>;

interface Options {
  models: (Favorite & { name: string })[];
  current?: Favorite;
  favorites: Favorite[];
  store: FavoritesStore;
  keybindings: KeybindingsManager;
  theme: SelectListTheme;
  render: () => void;
  done: (favorite?: Favorite) => void;
}

export class FavoritesMenu implements Component, Focusable {
  private readonly options: Options;
  private readonly input = new Input({ placeholder: "Search favorites..." });
  private favorites: Favorite[];
  private list!: SelectList;
  private browser?: FavoritesManager;
  private busy = false;
  private status = "";

  constructor(options: Options) {
    this.options = options;
    this.favorites = options.favorites;
    this.rebuild();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) {
    this.input.focused = value;
    if (this.browser) this.browser.focused = value;
  }

  private keys(action: keyof typeof DEFAULT_APP_KEYBINDINGS): KeyId[] {
    const configured = this.options.keybindings.getUserBindings()[action];
    return configured === undefined ? DEFAULT_APP_KEYBINDINGS[action] : Array.isArray(configured) ? configured : [configured];
  }

  private rebuild(selected?: string): void {
    const items = this.favorites.map((favorite) => {
      const key = modelKey(favorite);
      const model = this.options.models.find((item) => modelKey(item) === key);
      const status = !model ? " (unavailable)" : this.options.current && key === modelKey(this.options.current) ? " (current)" : "";
      return { value: key, label: `★ ${key}${status}`, description: model?.name };
    });
    const filtered = fuzzyFilter(items, this.input.getValue(), (item) => `${item.value} ${item.description ?? ""}`);
    this.list = new SelectList(filtered, 10, this.options.theme);
    if (selected) this.list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
  }

  private async returnFromBrowser(): Promise<void> {
    this.busy = true;
    try {
      this.favorites = await this.options.store.read();
      this.status = "";
      this.rebuild();
    } catch (error) {
      this.status = `Could not read favorites: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.browser = undefined;
      this.busy = false;
      this.options.render();
    }
  }

  async handleInput(data: string): Promise<void> {
    if (this.busy) return;
    if (this.browser) {
      await this.browser.handleInput(data);
      return;
    }
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel")) {
      this.options.done();
      return;
    }
    if (this.keys("pi-model-plus.add").some((key) => matchesKey(data, key))) {
      if (this.options.models.length === 0) {
        this.status = "No available models. Use /login or configure a provider first.";
      } else {
        this.browser = new FavoritesManager({
          ...this.options,
          favorites: this.favorites,
          toggle: (model) => this.options.store.update(model, "toggle"),
          done: () => this.returnFromBrowser(),
        });
        this.browser.focused = this.focused;
      }
    } else if (this.keys("pi-model-plus.remove").some((key) => matchesKey(data, key))) {
      const selected = this.list.getSelectedItem()?.value;
      const favorite = this.favorites.find((item) => modelKey(item) === selected);
      if (favorite) {
        this.busy = true;
        this.status = "Removing bookmark...";
        this.options.render();
        try {
          await this.options.store.update(favorite, "remove");
          this.favorites = this.favorites.filter((item) => modelKey(item) !== selected);
          this.rebuild(selected);
          this.status = `Removed bookmark for ${selected}`;
        } catch (error) {
          this.status = `Could not remove bookmark: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          this.busy = false;
        }
      }
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.list.getSelectedItem()?.value;
      const favorite = this.favorites.find((item) => modelKey(item) === selected);
      if (favorite) {
        if (this.options.models.some((item) => modelKey(item) === selected)) this.options.done(favorite);
        else this.status = "Model unavailable. Check /login or remove its bookmark.";
      }
    } else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const).some((action) => kb.matches(data, action))) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== previous) this.rebuild();
    }
    this.options.render();
  }

  render(width: number): string[] {
    if (this.browser) return this.browser.render(width);
    const kb = this.options.keybindings;
    return [
      truncateToWidth("Model Plus — favorite models", width),
      ...this.input.render(width),
      ...(this.favorites.length ? this.list.render(width) : [truncateToWidth("No favorites yet. Add models to get started.", width)]),
      truncateToWidth(this.status, width),
      truncateToWidth(`${this.keys("pi-model-plus.add").join("/")} add · ${this.keys("pi-model-plus.remove").join("/")} remove`, width),
      truncateToWidth(`${kb.getKeys("tui.select.confirm").join("/")} switch · ${kb.getKeys("tui.select.cancel").join("/")} close`, width),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
    this.browser?.invalidate();
  }
}
