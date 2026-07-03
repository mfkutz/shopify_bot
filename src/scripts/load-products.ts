import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

const SHOPIFY_STORE = process.env.SHOPIFY_STORE!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;

async function fetchShopifyProducts() {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=50`, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
  });

  const data = await response.json();
  return data.products;
}

function productToDocument(product: any): string {
  const variants = product.variants
    .map(
      (v: any) =>
        `${v.title !== "Default Title" ? v.title + " - " : ""}Precio: $${v.price} USD - Stock: ${v.inventory_quantity ?? "N/A"} unidades`,
    )
    .join(" | ");

  return `Producto: ${product.title}. ${product.body_html ? product.body_html.replace(/<[^>]*>/g, "") : "Sin descripción."}. Categoría: ${product.product_type || "General"}. Tags: ${product.tags || "ninguno"}. Variantes: ${variants}. Estado: ${product.status}.`;
}

async function loadProducts() {
  console.log("🛍️  Leyendo productos de Shopify...\n");

  const products = await fetchShopifyProducts();
  console.log(`📦 Encontrados ${products.length} productos\n`);

  // Limpiar documentos anteriores
  await supabase.from("documents").delete().neq("id", 0);
  console.log("🗑️  Tabla limpia\n");

  for (const product of products) {
    const doc = productToDocument(product);
    console.log(`📝 Procesando: ${product.title}`);

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: doc,
    });

    const embedding = embeddingResponse.data[0].embedding;

    const { error } = await supabase.from("documents").insert({
      content: doc,
      embedding: embedding,
    });

    if (error) {
      console.error(`   ❌ Error: ${error.message}`);
    } else {
      console.log(`   ✅ Cargado`);
    }
  }

  console.log("\n🎉 Todos los productos cargados en Supabase!");
}

loadProducts();
