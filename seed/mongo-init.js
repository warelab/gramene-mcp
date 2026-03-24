// Seed data for development/testing.
// Mounted into mongo container at /docker-entrypoint-initdb.d/init.js
// Runs automatically on first start (when the data volume is empty).

db = db.getSiblingDB("gramene");

// --- Taxonomy ---
db.taxonomy.insertMany([
  { _id: 3702,  name: "Arabidopsis thaliana" },
  { _id: 4577,  name: "Zea mays" },
  { _id: 39947, name: "Oryza sativa Japonica Group" },
  { _id: 4081,  name: "Solanum lycopersicum" },
  { _id: 3694,  name: "Populus trichocarpa" },
]);

// --- Gene Ontology ---
db.gene_ontology.insertMany([
  { _id: 3674,  name: "oxidoreductase activity" },
  { _id: 5488,  name: "binding" },
  { _id: 5515,  name: "protein binding" },
  { _id: 3700,  name: "transcription factor activity" },
  { _id: 16301, name: "kinase activity" },
]);

// --- Plant Ontology ---
db.plant_ontology.insertMany([
  { _id: 9025, name: "leaf" },
  { _id: 9030, name: "carpel" },
  { _id: 9005, name: "root" },
  { _id: 9049, name: "inflorescence" },
]);

// --- Trait Ontology ---
db.trait_ontology.insertMany([
  { _id: 1000, name: "plant height" },
  { _id: 2000, name: "grain yield" },
  { _id: 3000, name: "drought tolerance" },
]);

// --- Domains ---
db.domains.insertMany([
  { _id: 1,  name: "Protein kinase domain" },
  { _id: 2,  name: "Leucine-rich repeat" },
  { _id: 3,  name: "Zinc finger, C2H2 type" },
]);

// --- Pathways ---
db.pathways.insertMany([
  { _id: 1,  name: "Photosynthesis" },
  { _id: 2,  name: "Glycolysis / Gluconeogenesis" },
  { _id: 3,  name: "Phenylpropanoid biosynthesis" },
]);

print("MongoDB seed data loaded for gramene database.");
