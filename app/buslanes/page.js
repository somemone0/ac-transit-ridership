import BusLanes from "../../components/buslanes/BusLanes";
import "../../components/buslanes/buslanes.css";

export const metadata = {
  title: "Bus lanes and bus speeds: AC Transit 2019-2026",
  description: "Bus lanes added in the AC Transit service area since 2019, and average bus speeds on them before and after.",
};

export default function BusLanesPage() {
  return <BusLanes />;
}
