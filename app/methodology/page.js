import Methodology from "../../components/methodology/Methodology";
import "katex/dist/katex.min.css";
import "../../components/methodology/methodology.css";

export const metadata = {
  title: "Methodology: AC Transit ridership 2019-2026",
  description:
    "How the ridership figures are made: counter capture correction, the weekly blend, inferred origin-destination flows, corridor map matching, and what is known to be wrong.",
};

export default function MethodologyPage() {
  return <Methodology />;
}
