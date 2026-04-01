import './globals.css';

export const metadata = {
  title: 'FAQ Stress Tester',
  description: 'FAQ Policy Regression Checker',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
