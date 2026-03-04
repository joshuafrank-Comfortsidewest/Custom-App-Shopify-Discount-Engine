import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useMemo, useState} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

function App() {
  const {i18n, applyMetafieldChange, data} = shopify;

  const initial = useMemo(() => {
    const raw = data?.metafields?.find((m) => m.key === "function-configuration")?.value;
    try {
      const parsed = JSON.parse(raw || "{}");
      return {
        collection5Id: String(parsed.collection5Id || ""),
        collection10Id: String(parsed.collection10Id || ""),
      };
    } catch {
      return {collection5Id: "", collection10Id: ""};
    }
  }, [data?.metafields]);

  const [collection5Id, setCollection5Id] = useState(initial.collection5Id);
  const [collection10Id, setCollection10Id] = useState(initial.collection10Id);
  const [saved, setSaved] = useState(false);

  const onSubmit = async () => {
    setSaved(false);
    await applyMetafieldChange({
      type: "updateMetafield",
      namespace: "$app",
      key: "function-configuration",
      valueType: "json",
      value: JSON.stringify({
        collection5Id,
        collection10Id,
      }),
    });
    setSaved(true);
  };

  return (
    <s-function-settings onSubmit={(event) => event.waitUntil?.(onSubmit())}>
      <s-heading>{i18n.translate("title")}</s-heading>
      <s-section>
        <s-stack gap="base">
          <s-text>{i18n.translate("hint")}</s-text>
          <s-text-field
            label={i18n.translate("collection5")}
            name="collection5Id"
            value={collection5Id}
            defaultValue={initial.collection5Id}
            onInput={(event) => setCollection5Id(event.currentTarget.value)}
          />
          <s-text-field
            label={i18n.translate("collection10")}
            name="collection10Id"
            value={collection10Id}
            defaultValue={initial.collection10Id}
            onInput={(event) => setCollection10Id(event.currentTarget.value)}
          />
          {saved ? <s-banner tone="success">{i18n.translate("saved")}</s-banner> : null}
          <s-box inlineSize="140px">
            <s-button>{i18n.translate("save")}</s-button>
          </s-box>
        </s-stack>
      </s-section>
    </s-function-settings>
  );
}
