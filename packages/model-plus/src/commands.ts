import { type ExtensionAPI, type ExtensionContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { DefaultModelStore } from "./default-model.ts";
import { FavoritesMenu, type ModelSelection } from "./menu.ts";
import { FavoritesStore, modelKey } from "./store.ts";

type Context = Pick<ExtensionContext, "hasUI" | "model" | "mode"> & {
  ui: Pick<ExtensionContext["ui"], "notify" | "select" | "custom">;
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable">;
};
type Model = ReturnType<Context["modelRegistry"]["getAvailable"]>[number];

export function createCommand(store: FavoritesStore, setModel: ExtensionAPI["setModel"], defaults = new DefaultModelStore()) {
  return {
    description: "Favorite models: Enter switches, Ctrl+S sets default, Ctrl+N adds, Ctrl+R removes",
    handler: async (args: string, ctx: Context) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /model-plus (add and remove bookmarks inside the menu)", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/model-plus requires interactive mode or an RPC client with dialogs.", "warning");
        return;
      }
      try {
        const favorites = await store.read();
        const models = ctx.modelRegistry.getAvailable().sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
        let model: Model | undefined;
        let saveAsDefault = false;
        if (ctx.mode === "tui") {
          const defaultModel = defaults.read();
          const selected = await ctx.ui.custom<ModelSelection | undefined>((tui, _theme, keybindings, done) => new FavoritesMenu({
            models, current: ctx.model, defaultModel, favorites, store, keybindings,
            theme: getSelectListTheme(), render: () => tui.requestRender(), done,
          }));
          if (!selected) return;
          saveAsDefault = selected.saveAsDefault === true;
          model = ctx.modelRegistry.getAvailable().find((item) => modelKey(item) === modelKey(selected));
        } else {
          if (favorites.length === 0) {
            ctx.ui.notify("No favorites yet. Open /model-plus in interactive terminal mode to add bookmarks.", "info");
            return;
          }
          const items = favorites.map((favorite) => {
            const key = modelKey(favorite);
            const available = models.find((item) => modelKey(item) === key);
            const status = !available ? " (unavailable)" : ctx.model && key === modelKey(ctx.model) ? " (current)" : "";
            return { label: `${key}${status}`, model: available };
          });
          const selected = await ctx.ui.select("Favorite models", items.map((item) => item.label));
          if (selected === undefined) return;
          model = items.find((item) => item.label === selected)?.model;
        }
        if (!model) {
          ctx.ui.notify("This model is unavailable. Check /login and your provider configuration.", "warning");
          return;
        }
        if (await setModel(model)) {
          if (saveAsDefault) {
            try {
              await defaults.save(model);
            } catch (error) {
              ctx.ui.notify(`Switched to ${modelKey(model)}, but could not save default: ${error instanceof Error ? error.message : String(error)}`, "error");
              return;
            }
          }
          ctx.ui.notify(saveAsDefault ? `Default model: ${modelKey(model)}` : `Switched to ${modelKey(model)}`, "info");
        } else {
          ctx.ui.notify(`Could not switch to ${modelKey(model)}. Check /login and your provider configuration.`, "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Could not use favorites: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  };
}
