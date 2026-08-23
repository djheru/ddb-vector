/**
 * Demo seeder: posts ~12 recipes spanning several cuisines and dietary tags
 * through the deployed API. Not idempotent by design; running it twice seeds
 * duplicates with fresh ids.
 *
 * Usage: API_URL=https://... API_KEY=... npx tsx scripts/seed.ts
 */
import type { RecipeInput } from "../functions/shared/types";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
};

const apiUrl = requireEnv("API_URL").replace(/\/$/, "");
const apiKey = requireEnv("API_KEY");

// Small batches keep Bedrock throttling out of the picture while still
// exercising concurrent creates.
const BATCH_SIZE = 4;

const recipes: RecipeInput[] = [
  {
    name: "Spicy Chicken Stew",
    cuisine: "mexican",
    dietary: ["gluten-free"],
    prepTimeMinutes: 15,
    cookTimeMinutes: 45,
    servings: 4,
    description: "A fiery, slow-simmered chicken stew with chipotle peppers and roasted tomatoes.",
    ingredients: [
      { name: "chicken thighs", amount: "600", unit: "g" },
      { name: "chipotle peppers", amount: "2", unit: "pieces" },
      { name: "roasted tomatoes", amount: "400", unit: "g" },
    ],
    steps: ["Brown the chicken in a heavy pot", "Simmer with chipotle and tomatoes for 45 minutes"],
  },
  {
    name: "Chicken Tinga Tacos",
    cuisine: "mexican",
    dietary: ["dairy-free"],
    prepTimeMinutes: 20,
    cookTimeMinutes: 30,
    servings: 4,
    description: "Shredded chicken braised in a smoky chipotle tomato sauce, served on corn tortillas.",
    ingredients: [
      { name: "chicken breast", amount: "500", unit: "g" },
      { name: "chipotle in adobo", amount: "3", unit: "tbsp" },
      { name: "corn tortillas", amount: "12", unit: "pieces" },
    ],
    steps: ["Poach and shred the chicken", "Simmer in chipotle tomato sauce", "Serve on warm tortillas"],
  },
  {
    name: "Black Bean Enchiladas",
    cuisine: "mexican",
    dietary: ["vegetarian"],
    prepTimeMinutes: 25,
    cookTimeMinutes: 25,
    servings: 6,
    description: "Corn tortillas rolled around spiced black beans, baked under red chile sauce and cheese.",
    ingredients: [
      { name: "black beans", amount: "400", unit: "g" },
      { name: "red chile sauce", amount: "500", unit: "ml" },
      { name: "corn tortillas", amount: "12", unit: "pieces" },
    ],
    steps: ["Fill tortillas with spiced beans", "Cover with sauce and cheese", "Bake until bubbling"],
  },
  {
    name: "Spaghetti Carbonara",
    cuisine: "italian",
    dietary: [],
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    servings: 4,
    description: "Classic Roman pasta with eggs, pecorino cheese, pancetta, and black pepper.",
    ingredients: [
      { name: "spaghetti", amount: "400", unit: "g" },
      { name: "pancetta", amount: "200", unit: "g" },
      { name: "egg yolks", amount: "6", unit: "large" },
      { name: "pecorino romano", amount: "100", unit: "g" },
    ],
    steps: [
      "Boil pasta until al dente",
      "Cook pancetta until crispy",
      "Toss hot pasta with pancetta off heat, then stir in egg and cheese mixture",
    ],
  },
  {
    name: "Margherita Pizza",
    cuisine: "italian",
    dietary: ["vegetarian"],
    prepTimeMinutes: 90,
    cookTimeMinutes: 12,
    servings: 2,
    description: "Neapolitan-style pizza with tomato, fresh mozzarella, and basil on a blistered crust.",
    ingredients: [
      { name: "pizza dough", amount: "300", unit: "g" },
      { name: "san marzano tomatoes", amount: "200", unit: "g" },
      { name: "fresh mozzarella", amount: "150", unit: "g" },
      { name: "basil leaves", amount: "10", unit: "pieces" },
    ],
    steps: ["Stretch the dough", "Top with tomato and mozzarella", "Bake as hot as your oven goes"],
  },
  {
    name: "Mushroom Risotto",
    cuisine: "italian",
    dietary: ["vegetarian", "gluten-free"],
    prepTimeMinutes: 15,
    cookTimeMinutes: 35,
    servings: 4,
    description: "Creamy arborio rice slowly stirred with porcini mushrooms, white wine, and parmesan.",
    ingredients: [
      { name: "arborio rice", amount: "320", unit: "g" },
      { name: "porcini mushrooms", amount: "250", unit: "g" },
      { name: "vegetable stock", amount: "1.2", unit: "l" },
      { name: "parmesan", amount: "80", unit: "g" },
    ],
    steps: ["Soften mushrooms and onion", "Add rice and wine", "Ladle in stock until creamy"],
  },
  {
    name: "Chicken Teriyaki Bowl",
    cuisine: "japanese",
    dietary: ["dairy-free"],
    prepTimeMinutes: 15,
    cookTimeMinutes: 15,
    servings: 2,
    description: "Glazed chicken over steamed rice with a sweet soy and mirin teriyaki sauce.",
    ingredients: [
      { name: "chicken thighs", amount: "400", unit: "g" },
      { name: "soy sauce", amount: "60", unit: "ml" },
      { name: "mirin", amount: "60", unit: "ml" },
      { name: "steamed rice", amount: "2", unit: "cups" },
    ],
    steps: ["Sear the chicken", "Reduce sauce until glossy", "Serve over rice"],
  },
  {
    name: "Vegetable Miso Ramen",
    cuisine: "japanese",
    dietary: ["vegan"],
    prepTimeMinutes: 20,
    cookTimeMinutes: 30,
    servings: 2,
    description: "Rich miso broth with ramen noodles, charred corn, bok choy, and soft tofu.",
    ingredients: [
      { name: "ramen noodles", amount: "200", unit: "g" },
      { name: "white miso", amount: "4", unit: "tbsp" },
      { name: "bok choy", amount: "2", unit: "heads" },
      { name: "soft tofu", amount: "200", unit: "g" },
    ],
    steps: ["Build the miso broth", "Cook noodles separately", "Assemble with toppings"],
  },
  {
    name: "Chana Masala",
    cuisine: "indian",
    dietary: ["vegan", "gluten-free"],
    prepTimeMinutes: 15,
    cookTimeMinutes: 35,
    servings: 4,
    description: "Chickpeas simmered in a spiced tomato and onion gravy with garam masala and ginger.",
    ingredients: [
      { name: "chickpeas", amount: "480", unit: "g" },
      { name: "tomatoes", amount: "400", unit: "g" },
      { name: "garam masala", amount: "2", unit: "tsp" },
      { name: "fresh ginger", amount: "20", unit: "g" },
    ],
    steps: ["Fry onions and spices", "Add tomatoes and chickpeas", "Simmer until thick"],
  },
  {
    name: "Butter Chicken",
    cuisine: "indian",
    dietary: ["gluten-free"],
    prepTimeMinutes: 30,
    cookTimeMinutes: 40,
    servings: 4,
    description: "Tandoori-marinated chicken folded into a silky spiced tomato and butter sauce.",
    ingredients: [
      { name: "chicken breast", amount: "600", unit: "g" },
      { name: "yogurt", amount: "150", unit: "g" },
      { name: "tomato passata", amount: "400", unit: "ml" },
      { name: "butter", amount: "80", unit: "g" },
    ],
    steps: ["Marinate and grill the chicken", "Simmer the sauce", "Combine and finish with cream"],
  },
  {
    name: "Ratatouille",
    cuisine: "french",
    dietary: ["vegan", "gluten-free"],
    prepTimeMinutes: 30,
    cookTimeMinutes: 60,
    servings: 6,
    description: "Provencal stewed vegetables: eggplant, zucchini, peppers, and tomato with herbs.",
    ingredients: [
      { name: "eggplant", amount: "2", unit: "pieces" },
      { name: "zucchini", amount: "3", unit: "pieces" },
      { name: "bell peppers", amount: "2", unit: "pieces" },
      { name: "tomatoes", amount: "600", unit: "g" },
    ],
    steps: ["Saute each vegetable separately", "Layer with tomato and herbs", "Bake low and slow"],
  },
  {
    name: "Greek Salad",
    cuisine: "greek",
    dietary: ["vegetarian", "gluten-free"],
    prepTimeMinutes: 15,
    cookTimeMinutes: 0,
    servings: 4,
    description: "Tomatoes, cucumber, olives, and feta with oregano and olive oil, no lettuce in sight.",
    ingredients: [
      { name: "tomatoes", amount: "4", unit: "pieces" },
      { name: "cucumber", amount: "1", unit: "pieces" },
      { name: "kalamata olives", amount: "100", unit: "g" },
      { name: "feta", amount: "200", unit: "g" },
    ],
    steps: ["Chop the vegetables", "Dress with oil and oregano", "Top with feta"],
  },
];

interface CreateResponse {
  recipeId?: string;
  error?: string;
}

const createRecipe = async (recipe: RecipeInput): Promise<boolean> => {
  const response = await fetch(`${apiUrl}/recipes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(recipe),
  });
  const body = (await response.json()) as CreateResponse;
  if (response.status !== 201) {
    console.error(`FAIL ${recipe.name}: ${response.status} ${JSON.stringify(body)}`);
    return false;
  }
  console.log(`Created ${recipe.name} (${recipe.cuisine}) -> ${body.recipeId}`);
  return true;
};

const main = async (): Promise<void> => {
  let failures = 0;
  for (let start = 0; start < recipes.length; start += BATCH_SIZE) {
    const batch = recipes.slice(start, start + BATCH_SIZE);
    const outcomes = await Promise.allSettled(batch.map((recipe) => createRecipe(recipe)));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected" || !outcome.value) failures += 1;
    }
  }
  console.log(`Seed complete: ${recipes.length - failures}/${recipes.length} recipes created`);
  if (failures > 0) process.exit(1);
};

await main();
