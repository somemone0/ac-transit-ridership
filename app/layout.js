import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata = {
  title: "AC Transit Ridership 2019-2026",
  description: "Weekly AC Transit ridership and recovery explorer.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
