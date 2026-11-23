/* ORRIA Marketplace shell. Product inventory intentionally deferred. */
(function(){
  const categories=[
    {title:"Flowers & Plants",items:["Flowers & Bouquets","Roses","Orchids","Indoor Plants","Planters"],image:"https://images.unsplash.com/photo-1490750967868-88aa4486c946?auto=format&fit=crop&w=800&q=82"},
    {title:"Cakes & Chocolates",items:["Birthday Cakes","Designer Cakes","Eggless Cakes","Chocolate Gifts","Desserts"],image:"https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=800&q=82"},
    {title:"Gift Hampers",items:["Chocolate Hampers","Dry Fruit Hampers","Gourmet Gifts","Sweets","Premium Gift Boxes"],image:"https://images.unsplash.com/photo-1549465220-1a8b9238cd48?auto=format&fit=crop&w=800&q=82"},
    {title:"Personalised Gifts",items:["Photo Frames","Name Gifts","Custom Mugs","LED Gifts","Personalised Keepsakes"],image:"https://images.unsplash.com/photo-1513201099705-a9746e1e201f?auto=format&fit=crop&w=800&q=82"},
    {title:"Home & Living",items:["Home Décor","Candles","Trays & Coasters","Vases","Decorative Accessories"],image:"https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=800&q=82"},
    {title:"Beauty & Wellness",items:["Skincare","Beauty Gifts","Grooming","Self-care Hampers"],image:"https://images.unsplash.com/photo-1601049541289-9b1b7bbbfe19?auto=format&fit=crop&w=800&q=82"},
    {title:"Fashion & Lifestyle",items:["Watches","Bags","Jewellery","Accessories"],image:"https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=800&q=82"},
    {title:"Kids, Toys & Games",items:["Soft Toys","Educational Toys","Board Games","Kids Gifts"],image:"https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&w=800&q=82"},
    {title:"Celebrations",items:["Balloons","Party Décor","Celebration Supplies","Anniversary Décor"],image:"https://images.unsplash.com/photo-1530103862676-de8c9deblad?auto=format&fit=crop&w=800&q=82"},
    {title:"Corporate Gifting",items:["Employee Gifts","Client Hampers","Festival Gifts","Bulk Orders"],image:"https://images.unsplash.com/photo-1607344645866-009c320c5ab8?auto=format&fit=crop&w=800&q=82"}
  ];
  const occasions=["Birthday","Anniversary","Wedding","Housewarming","Congratulations","Thank You"];
  const safe=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function goShop(){if(typeof window.go==="function")window.go("shop");else location.hash="#shop";}
  function mount(){
    const header=document.querySelector("header .nav"); if(!header||document.getElementById("orMegaMenu"))return;
    const nav=document.createElement("div");nav.className="or-market-nav";nav.innerHTML='<button type="button" id="orShopAll" aria-expanded="false">SHOP ALL</button><button type="button" id="orOccasion">BY OCCASION</button><button type="button" id="orGifting">GIFTING</button>';
    const actions=header.querySelector(".actions");header.insertBefore(nav,actions||null);
    const mega=document.createElement("div");mega.className="or-mega";mega.id="orMegaMenu";
    mega.innerHTML='<div class="or-mega-grid">'+categories.map(c=>'<div class="or-mega-group"><h3>'+safe(c.title)+'</h3>'+c.items.map(i=>'<button type="button" data-or-category="'+safe(c.title)+'">'+safe(i)+'</button>').join("")+'</div>').join("")+'</div>';
    document.querySelector("header").appendChild(mega);
    const toggle=(open)=>{mega.classList.toggle("open",open);document.getElementById("orShopAll").setAttribute("aria-expanded",String(open));};
    document.getElementById("orShopAll").addEventListener("click",()=>toggle(!mega.classList.contains("open")));
    document.getElementById("orOccasion").addEventListener("click",()=>{toggle(false);document.getElementById("orOccasionSection")?.scrollIntoView({behavior:"smooth"});});
    document.getElementById("orGifting").addEventListener("click",()=>{toggle(false);document.getElementById("orMarketplaceCategories")?.scrollIntoView({behavior:"smooth"});});
    mega.addEventListener("click",e=>{const b=e.target.closest("[data-or-category]");if(b){toggle(false);goShop();}});
    document.addEventListener("click",e=>{if(!e.target.closest("header"))toggle(false);});
    const top=document.querySelector(".top");if(top)top.textContent="THOUGHTFUL GIFTS FOR EVERY MOMENT  •  DISCOVER THE ORRIA EDIT";
    const home=document.getElementById("home");if(!home)return;
    const oldCat=home.querySelector(".categories");
    const section=document.createElement("section");section.className="section";section.id="orMarketplaceCategories";
    section.innerHTML='<div class="or-category-intro"><div><div class="eyebrow">DISCOVER ORRIA</div><h2 style="font:500 40px Georgia,serif;margin:0">Shop every kind of thoughtful</h2><p class="muted">A growing destination for gifting, celebrations and beautiful everyday finds.</p></div><button class="btn alt" type="button" id="orViewAll">EXPLORE ALL</button></div><div class="or-category-grid">'+categories.map(c=>'<button class="or-category-tile" type="button" style="--tile-image:url(\''+c.image+'\')"><span>'+safe(c.title)+'</span></button>').join("")+'</div>';
    if(oldCat?.closest("section"))oldCat.closest("section").insertAdjacentElement("afterend",section);else home.prepend(section);
    section.querySelectorAll(".or-category-tile").forEach(b=>b.addEventListener("click",goShop));section.querySelector("#orViewAll").addEventListener("click",goShop);
    const occasions=document.createElement("section");occasions.className="section";occasions.id="orOccasionSection";
    occasions.innerHTML='<div class="sectionHead"><div><div class="eyebrow">MAKE THEIR MOMENT</div><h2>Shop by occasion</h2><p class="muted">Find a thoughtful gesture for every celebration.</p></div></div><div class="or-occasion-grid">'+occasionsList()+'</div>';
    section.insertAdjacentElement("afterend",occasions);
    const note=document.createElement("section");note.className="section";note.innerHTML='<div class="or-marketplace-note"><div><div class="eyebrow">THE ORRIA PROMISE</div><h2>One destination. Every occasion.</h2><p>Explore gifting, home, lifestyle and celebration categories. Product collections will be added as inventory is onboarded.</p></div><button class="btn" type="button">EXPLORE ORRIA</button></div>';
    occasions.insertAdjacentElement("afterend",note);note.querySelector("button").addEventListener("click",goShop);
    const shop=document.getElementById("shop");
    if(shop&&!shop.querySelector(".or-market-placeholder")){const p=document.createElement("div");p.className="or-market-placeholder";p.innerHTML="<strong>ORRIA Marketplace is being prepared.</strong><br>Category browsing is available now. Product listings will appear here as the catalogue is added.";shop.querySelector(".shopHead")?.insertAdjacentElement("afterend",p);}
    const mobile=header.querySelector(".actions");if(mobile&&!header.querySelector("#orMobileMenu")){const b=document.createElement("button");b.id="orMobileMenu";b.className="iconbtn";b.type="button";b.textContent="☰";b.setAttribute("aria-label","Open categories");b.addEventListener("click",()=>mega.classList.toggle("open"));mobile.prepend(b);}
  }
  function occasionsList(){return occasions.map(x=>'<button class="or-occasion" type="button"><strong>'+safe(x)+'</strong><small>Explore gifts</small></button>').join("");}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();
})();