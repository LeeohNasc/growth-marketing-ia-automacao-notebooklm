import { createRoot } from "react-dom/client";
import { EditorialEditor } from "../app/w/[workspace]/create/editorial/[id]/editor";

type Props = Parameters<typeof EditorialEditor>[0];
(window as unknown as { mountEditor: (p: Props) => void }).mountEditor = (p) => {
  const fake = (window as unknown as { __fake: { card: unknown } }).__fake;
  fake.card = { ...p.card };
  createRoot(document.getElementById("root")!).render(<EditorialEditor {...p} />);
};
document.body.dataset.ready = "1";
