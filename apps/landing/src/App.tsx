import type { JSX } from 'react';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Security } from './components/Security';
import { Features } from './components/Features';
import { AgencyOps } from './components/AgencyOps';
import { Download } from './components/Download';
import { Footer } from './components/Footer';
import { useReveal } from './components/useReveal';

export function App(): JSX.Element {
  useReveal();
  return (
    <>
      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Bỏ qua tới nội dung
      </a>
      <Nav />
      <main>
        <Hero />
        <Security />
        <Features />
        <AgencyOps />
        <Download />
      </main>
      <Footer />
    </>
  );
}
