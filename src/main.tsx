import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toaster>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </Toaster>
  </StrictMode>,
);
