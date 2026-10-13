import { Team } from "@/components/sections/Team";
import { Navbar } from "@/components/sections/Navbar";
import { Footer } from "@/components/sections/Footer";

export default function TeamPage() {
  return (
    <>
      <Navbar />

      <main>
        <Team />
      </main>

      <Footer />
    </>
  );
}